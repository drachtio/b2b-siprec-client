module.exports = function(srf, logger) {

  const initLocals = (req, res, next) => {
    const callId = req.get('Call-ID');
    req.locals = {
      ...req.locals,
      callId,
      sdp: req.body,
      logger: logger.child({callId})
    };
    next();
  };

  return {
    initLocals
  };
};
