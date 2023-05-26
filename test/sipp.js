const { spawn } = require('child_process');
const debug = require('debug')('siprec:ci');
let network;
const obj = {};
let output = '';
let idx = 1;

function clearOutput() {
  output = '';
}

function addOutput(str) {
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) < 128) output += str.charAt(i);
  }
}

module.exports = (networkName) => {
  network = networkName ;
  return obj;
};

obj.output = () => {
  return output;
};

obj.sippUac = (file, bindAddress) => {
  const cmd = 'docker';
  const args = [
    'run', '--rm', '--net', `${network}`,
    '-v', `${__dirname}/scenarios:/tmp/scenarios`,
    'drachtio/sipp', 'sipp', '-sf', `/tmp/scenarios/${file}`,
    '-m', '1',
    '-sleep', '250ms',
    '-nostdin',
    '-cid_str', `%u-%p@%s-${idx++}`,
    'sbc', '-trace_msg'
  ];

  if (bindAddress) args.splice(4, 0, '--ip', bindAddress);

  //console.log(args.join(' '));
  clearOutput();

  return new Promise((resolve, reject) => {
    const child_process = spawn(cmd, args, {stdio: ['inherit', 'pipe', 'pipe']});

    child_process.on('exit', (code, signal) => {
      if (code === 0) {
        return resolve();
      }
      console.log(`sipp exited with non-zero code ${code} signal ${signal}`);
      reject(code);
    });
    child_process.on('error', (error) => {
      console.log(`error spawing child process for docker: ${args}`);
    });

    child_process.stdout.on('data', (data) => {
      debug(`stderr: ${data}`);
      addOutput(data.toString());
    });
    child_process.stderr.on('data', (data) => {
      debug(`stderr: ${data}`);
      addOutput(data.toString());
    });
  });
};
