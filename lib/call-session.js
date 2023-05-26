const Emitter = require('events');
const debug = require('debug')('siprec');
const config = require('config');
const SrsClient = require('@jambonz/siprec-client-utils');
const {parseUri} = require('drachtio-srf');
const {
  makeRtpEngineOpts,
  parseConnectionIp
} = require('./utils');
const { forwardInDialogRequests } = require('drachtio-fn-b2b-sugar');

const SdpWantsSrtp = (sdp) => {
  return /m=audio.*SAVP/.test(sdp);
};

/**
 * this is to make sure the outgoing From has the number in the incoming From
 * and not the incoming PAI
 */
const createBLegFromHeader = (req) => {
  const from = req.getParsedHeader('From');
  const uri = parseUri(from.uri);
  const name = from.name;
  const displayName = name ? `${name} ` : '';
  if (uri && uri.user) return `${displayName}<sip:${uri.user}@localhost>`;
  else return `${displayName}<sip:anonymous@localhost>`;
};

class CallSession extends Emitter {
  constructor(req, res) {
    super();
    this.req = req;
    this.res = res;
    this.srf = req.srf;
    this.logger = req.locals.logger;

    const { getRtpEngine } = req.srf.locals;
    this.getRtpEngine = getRtpEngine;
  }

  get privateSipAddress() {
    return this.srf.locals.privateSipAddress;
  }

  async connect() {
    const {sdp} = this.req.locals;
    this.logger.info('inbound call accepted for routing');
    const engine = this.getRtpEngine();

    if (!engine) {
      this.logger.info('No available rtpengines, rejecting call!');
      return this.res.send(480);
    }

    debug(`got engine: ${JSON.stringify(engine)}`);
    const {
      offer,
      answer,
      del,
      blockMedia,
      unblockMedia,
      blockDTMF,
      unblockDTMF,
      playDTMF,
      subscribeDTMF,
      unsubscribeDTMF,
      subscribeRequest,
      subscribeAnswer,
      unsubscribe
    } = engine;
    this.offer = offer;
    this.answer = answer;
    this.del = del;
    this.blockMedia = blockMedia;
    this.unblockMedia = unblockMedia;
    this.blockDTMF = blockDTMF;
    this.unblockDTMF = unblockDTMF;
    this.playDTMF = playDTMF;
    this.subscribeDTMF = subscribeDTMF;
    this.unsubscribeDTMF = unsubscribeDTMF;
    this.subscribeRequest = subscribeRequest;
    this.subscribeAnswer = subscribeAnswer;
    this.unsubscribe = unsubscribe;
    this.srsUrl = config.get('srsUrl');

    // Prepare media resources
    this.rtpEngineOpts = makeRtpEngineOpts(this.req, SdpWantsSrtp(sdp), false);
    this.rtpEngineResource = {destroy: this.del.bind(null, this.rtpEngineOpts.common)};

    let uri, trunk;
    const trunks = config.get('trunks');
    if (trunks && trunks.length) {
      const random = Math.floor(Math.random() * trunks.length);
      trunk = trunks[random];
      uri = `sip:${this.req.calledNumber}@${trunk.host}`;
    } else {
      this.logger.error('There is no available next trunks.');
      throw new Error('There is no available next trunks.');
    }

    try {
      const opts = {
        ...this.rtpEngineOpts.common,
        ...this.rtpEngineOpts.uac.mediaOpts,
        'from-tag': this.rtpEngineOpts.uas.tag,
        direction:  ['public', 'private'],
        sdp
      };

      const response = await this.offer(opts);
      this.rtpengineIp = opts.sdp ? parseConnectionIp(opts.sdp) : 'undefined';
      this.logger.debug({opts, response, rtpengine: this.rtpengineIp}, 'response from rtpengine to offer');

      if ('ok' !== response.result) {
        this.logger.error({}, `rtpengine offer failed with ${JSON.stringify(response)}`);
        throw new Error('rtpengine failed: offer');
      }

      let headers = {
        'From': createBLegFromHeader(this.req),
        'To': this.req.get('To'),
        'X-Forwarded-For': `${this.req.source_address}`
      };

      if (this.privateSipAddress) headers = {...headers, Contact: `<sip:${this.privateSipAddress}>`};

      const responseHeaders = {};
      // now send the INVITE in towards the trunk
      debug(`sending INVITE to ${trunk} with ${uri}`);
      const {uas, uac} = await this.srf.createB2BUA(this.req, this.res, uri, {
        headers,
        ...(trunk && { auth: trunk.auth }),
        responseHeaders,
        proxyRequestHeaders: [
          'all',
          '-Authorization',
          '-Max-Forwards',
          '-Record-Route',
          '-Session-Expires',
          '-X-Subspace-Forwarded-For'
        ],
        proxyResponseHeaders: ['all', '-X-Trace-ID'],
        localSdpB: response.sdp,
        localSdpA: async(sdp, res) => {
          this.rtpEngineOpts.uac.tag = res.getParsedHeader('To').params.tag;
          const opts = {
            ...this.rtpEngineOpts.common,
            ...this.rtpEngineOpts.uas.mediaOpts,
            'from-tag': this.rtpEngineOpts.uas.tag,
            'to-tag': this.rtpEngineOpts.uac.tag,
            sdp
          };
          const response = await this.answer(opts);
          this.logger.debug({response, opts}, 'response from rtpengine to answer');
          if ('ok' !== response.result) {
            this.logger.error(`rtpengine answer failed with ${JSON.stringify(response)}`);
            throw new Error('rtpengine failed: answer');
          }

          this._startRecordingSession();

          return response.sdp;
        }
      });

      // successfully connected
      this.logger.info('call connected successfully to feature server');
      debug('call connected successfully to feature server');
      this._setHandlers({uas, uac});
    } catch (error) {
      this.rtpEngineResource.destroy().catch((err) => this.logger.info({err}, 'Error destroying rtpe after failure'));
      this.logger.error(error, 'unexpected error routing inbound call');
      this.srf.endSession(this.req);
      if (this.srsClient) {
        this.srsClient.stop();
        this.srsClient = null;
      }
      this.emit('failed');
    }
  }

  async _handleReinvite(dlg, req, res) {
    const fromTag = dlg.type === 'uas' ? this.rtpEngineOpts.uas.tag : this.rtpEngineOpts.uac.tag;
    const toTag = dlg.type === 'uas' ? this.rtpEngineOpts.uac.tag : this.rtpEngineOpts.uas.tag;
    const offerMedia = dlg.type === 'uas' ? this.rtpEngineOpts.uac.mediaOpts : this.rtpEngineOpts.uas.mediaOpts;
    const answerMedia = dlg.type === 'uas' ? this.rtpEngineOpts.uas.mediaOpts : this.rtpEngineOpts.uac.mediaOpts;
    const direction =  dlg.type === 'uas' ? ['public', 'private'] : ['private', 'public'];

    try {

      const offeredSdp = Array.isArray(req.payload) && req.payload.length > 1 ?
        req.payload.find((p) => p.type === 'application/sdp').content :
        req.body;
      let opts = {
        ...this.rtpEngineOpts.common,
        ...offerMedia,
        'from-tag': fromTag,
        'to-tag': toTag,
        direction,
        sdp: offeredSdp,
      };

      let response = await this.offer(opts);
      if ('ok' !== response.result) {
        res.send(488);
        throw new Error(`_onReinvite: rtpengine failed: offer: ${JSON.stringify(response)}`);
      }

      const sdp = await dlg.other.modify(response.sdp);
      opts = {
        ...this.rtpEngineOpts.common,
        ...answerMedia,
        'from-tag': fromTag,
        'to-tag': toTag,
        sdp
      };
      response = await this.answer(opts);
      if ('ok' !== response.result) {
        res.send(488);
        throw new Error(`_onReinvite: rtpengine failed: ${JSON.stringify(response)}`);
      }
      res.send(200, {body: response.sdp});
    } catch (err) {
      this.logger.error(err, 'Error handling reinvite');
    }
  }


  async _onDTMF(dlg, payload) {
    this.logger.info({payload}, '_onDTMF');
    try {
      let dtmf;
      switch (payload.event) {
        case 10:
          dtmf = '*';
          break;
        case 11:
          dtmf = '#';
          break;
        default:
          dtmf = '' + payload.event;
          break;
      }
      await dlg.request({
        method: 'INFO',
        headers: {
          'Content-Type': 'application/dtmf-relay'
        },
        body: `Signal=${dtmf}
Duration=${payload.duration} `
      });
    } catch (err) {
      this.logger.info({err}, 'Error sending INFO application/dtmf-relay');
    }
  }

  subscribeForDTMF(dlg) {
    if (!this._subscribedForDTMF) {
      this._subscribedForDTMF = true;
      this.subscribeDTMF(this.logger, this.req.get('Call-ID'), this.rtpEngineOpts.uas.tag,
        this._onDTMF.bind(this, dlg));
    }
  }

  unsubscribeForDTMF() {
    if (this._subscribedForDTMF) {
      this._subscribedForDTMF = false;
      this.unsubscribeDTMF(this.logger, this.req.get('Call-ID'), this.rtpEngineOpts.uas.tag);
    }
  }

  async _handleInfo(dlg, req, res) {
    this.logger.info(`received info with content-type: ${req.get('Content-Type')}`);

    try {
      const immutableHdrs = ['via', 'from', 'to', 'call-id', 'cseq', 'max-forwards', 'content-length'];
      const headers = {};
      Object.keys(req.headers).forEach((h) => {
        if (!immutableHdrs.includes(h)) headers[h] = req.headers[h];
      });
      const response = await dlg.other.request({ method: 'INFO', headers, body: req.body });
      const responseHeaders = {};
      if (response.has('Content-Type')) {
        Object.assign(responseHeaders, { 'Content-Type': response.get('Content-Type') });
      }
      res.send(response.status, { headers: responseHeaders, body: response.body });
    } catch (err) {
      this.logger.info({ err }, `Error handing INFO request on ${dlg.type} leg`);
    }
  }

  _setHandlers({uas, uac}) {
    this.emit('connected');
    this.uas = uas;
    this.uac = uac;
    [uas, uac].forEach((dlg) => {
      dlg.on('destroy', async() => {
        const other = dlg.other;
        this.rtpEngineResource.destroy().catch((err) => {});
        try {
          await other.destroy();
        } catch (err) {}
        this.unsubscribeForDTMF();
        /* de-link the 2 Dialogs for GC */
        dlg.removeAllListeners();
        other.removeAllListeners();
        dlg.other = null;
        other.other = null;

        if (this.srsClient) {
          this.srsClient.stop();
          this.srsClient = null;
        }
        this.srf.endSession(this.req);
        if (this.srsClient) {
          this.srsClient.stop();
          this.srsClient = null;
        }
      });
    });

    this.subscribeForDTMF(uac);

    uas.on('modify', this._handleReinvite.bind(this, uas));
    uac.on('modify', this._handleReinvite.bind(this, uac));

    uas.on('info', this._handleInfo.bind(this, uas));
    uac.on('info', this._handleInfo.bind(this, uac));

    // default forwarding of other request types
    forwardInDialogRequests(uas, ['notify', 'options', 'message', 'refer']);
  }

  async _startRecordingSession() {
    const toTag = this.rtpEngineOpts.uas.tag;
    const from = this.req.getParsedHeader('From');
    const to = this.req.getParsedHeader('To');
    const aorFrom = from.uri;
    const aorTo = to.uri;
    this.logger.info({to, from}, 'startCallRecording request for a call');

    this.srsClient = new SrsClient(this.logger, {
      srf: this.srf,
      direction: 'inbound',
      originalInvite: this.req,
      callingNumber: this.req.callingNumber,
      calledNumber: this.req.calledNumber,
      srsUrl: this.srsUrl,
      rtpEngineOpts: this.rtpEngineOpts,
      toTag,
      aorFrom,
      aorTo,
      subscribeRequest: this.subscribeRequest,
      subscribeAnswer: this.subscribeAnswer,
      del: this.del,
      blockMedia: this.blockMedia,
      unblockMedia: this.unblockMedia,
      unsubscribe: this.unsubscribe
    });
    try {
      await this.srsClient.start();
    } catch (err) {
      this.logger.error({err}, 'Error starting SipRec call recording');
    }
  }
}


module.exports = CallSession;
