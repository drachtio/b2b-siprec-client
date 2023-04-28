const rtpCharacteristics = require('../data/rtp-transcoding.json');
const srtpCharacteristics = require('../data/srtp-transcoding.json');

function makeRtpEngineOpts(req, srcIsUsingSrtp, dstIsUsingSrtp) {
  const from = req.getParsedHeader('from');
  const dstOpts = dstIsUsingSrtp ? srtpCharacteristics : rtpCharacteristics;
  const srctOpts = srcIsUsingSrtp ? srtpCharacteristics : rtpCharacteristics;
  const common = {
    'call-id': req.get('Call-ID'),
    'replace': ['origin', 'session-connection'],
    'record call': 'no'
  };
  return {
    common,
    uas: {
      tag: from.params.tag,
      mediaOpts: srctOpts
    },
    uac: {
      tag: null,
      mediaOpts: dstOpts
    }
  }
};

const parseConnectionIp = (sdp) => {
  const regex = /c=IN IP4 ([0-9.]+)/;
  const arr = regex.exec(sdp);
  return arr ? arr[1] : null;
};

module.exports = {
  makeRtpEngineOpts,
  parseConnectionIp
};
