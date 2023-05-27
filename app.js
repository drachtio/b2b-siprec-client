const Srf = require('drachtio-srf');
const srf = new Srf('siprec-b2bua');
const config = require('config') ;
const logOpts = {level: config.get('siprec.log_level')};
const logger = require('pino')(logOpts);
const { hostport, opts = {} } = config.get('rtpengine');
const CallSession = require('./lib/call-session');

const {getRtpEngine, setRtpEngines} = require('@jambonz/rtpengine-utils')([], logger, opts);
/**
 * Set the array of rtpengines, each entry a host:port that rtpengine is listening on for ng
 * NB: this could be called at any time with a new array of rtpengines, as they go down / come up
 */
setRtpEngines(hostport);

srf.locals = {
  ...srf.locals,
  getRtpEngine
};

const {
  initLocals
} = require('./lib/middleware')(srf, logger);

srf.use('invite', [initLocals]);
srf.invite((req, res) => {
  const session = new CallSession(req, res);
  session.connect();
});


srf.connect(config.get('drachtio'));
srf.on('connect', (err, hp) => {
  if (err) return this.logger.error({err}, 'Error connecting to drachtio server');
  logger.info(`connected to drachtio listening on ${hp}`);
});

module.exports = {
  srf
};

