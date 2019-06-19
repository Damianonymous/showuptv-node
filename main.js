const Promise = require('bluebird');
const fs = Promise.promisifyAll(require('fs'));
const childProcess = require('child_process');
const path = require('path');
const bhttp = require('bhttp');
const cheerio = require('cheerio');
const colors = require('colors');
const moment = require('moment');
const yaml = require('js-yaml');
const mvAsync = Promise.promisify(require('mv'));
const mkdirpAsync = Promise.promisify(require('mkdirp'));

const session = bhttp.session();

const config = yaml.safeLoad(fs.readFileSync('config.yml', 'utf8'));

config.captureDirectory = config.captureDirectory || 'capture';
config.completeDirectory = config.completeDirectory || 'complete';
config.modelScanInterval = config.modelScanInterval || 60;
config.minFileSizeMb = config.minFileSizeMb || 5;
config.debug = !!config.debug;
config.rtmpDebug = !!config.rtmpDebug;
config.models = Array.isArray(config.models) ? config.models : [];
config.dateFormat = config.dateFormat || 'YYYYMMDD-HHmmss';
config.createModelDirectory = !!config.createModelDirectory;

const captureDirectory = path.resolve(__dirname, config.captureDirectory);
const completeDirectory = path.resolve(__dirname, config.completeDirectory);
const minFileSize = config.minFileSizeMb * 1048576;

let captures = [];

function printMsg(...args) {
  console.log.apply(console, [colors.gray(`[${moment().format('MM/DD/YYYY - HH:mm:ss')}]`), ...args]);
}

const printErrorMsg = printMsg.bind(printMsg, colors.red('[ERROR]'));
const printDebugMsg = config.debug ? printMsg.bind(printMsg, colors.yellow('[DEBUG]')) : () => {};

function captureModel(params) {
  const { model, streamServer, playpath } = params;

  return Promise
    .try(() => {
      printMsg(colors.green(model), 'is online, starting rtmpdump process');

      const filename = `${model}_${moment().format(config.dateFormat)}.flv`;

      const spawnArguments = [
        '--live',
        config.rtmpDebug ? '' : '--quiet',
        '--rtmp', `rtmp://${streamServer}:1935/webrtc`,
        '--playpath', `${playpath}_aac`,
        '--flv', path.join(captureDirectory, filename),
      ];

      printDebugMsg('spawnArguments:', spawnArguments);

      const proc = childProcess.spawn('rtmpdump', spawnArguments);

      proc.stdout.on('data', (data) => {
        printMsg(data.toString());
      });

      proc.stderr.on('data', (data) => {
        printMsg(data.toString());
      });

      proc.on('close', () => {
        printMsg(colors.green(model), 'stopped streaming');

        captures = captures.filter(c => c.model !== model);

        const src = path.join(captureDirectory, filename);
        const dst = config.createModelDirectory
          ? path.join(completeDirectory, model, filename)
          : path.join(completeDirectory, filename);

        fs.statAsync(src)
          // if the file is big enough we keep it otherwise we delete it
          .then(stats => (stats.size <= minFileSize
            ? fs.unlinkAsync(src)
            : mvAsync(src, dst, { mkdirp: true })
          ))
          .catch((err) => {
            if (err.code !== 'ENOENT') {
              printErrorMsg(colors.red(`[${model}]`), err.toString());
            }
          });
      });

      if (proc.pid) {
        captures.push({
          model,
          filename,
          proc,
          checkAfter: moment().unix() + 60, // we are gonna check the process after 60 seconds
          size: 0,
        });
      }
    })
    .catch((err) => {
      printErrorMsg(colors.red(`[${model.model}]`), err.toString());
    });
}

function checkCapture(capture) {
  if (!capture.checkAfter || capture.checkAfter > moment().unix()) {
    // if this is not the time to check the process then we resolve immediately
    printDebugMsg(colors.green(capture.model), '- OK');
    return null;
  }

  printDebugMsg(colors.green(capture.model), 'should be checked');

  return fs
    .statAsync(path.join(captureDirectory, capture.filename))
    .then((stats) => {
      // we check the process after 60 seconds since the its start,
      // then we check it every 10 minutes,
      // if the size of the file has not changed over the time, we kill the process
      if (stats.size - capture.size > 0) {
        printDebugMsg(colors.green(capture.model), '- OK');

        capture.checkAfter = moment().unix() + 600; // 10 minutes
        capture.size = stats.size;
      } else if (capture.model) {
        // we assume that onClose will do all the cleaning for us
        printErrorMsg(colors.red(`[${capture.model}]`), 'Process is dead');
        capture.childProcess.kill();
      }
    })
    .catch((err) => {
      if (err.code === 'ENOENT') {
        // do nothing, file does not exists,
      } else {
        printErrorMsg(colors.red(`[${capture.model}]`), err.toString());
      }
    });
}

function mainLoop() {
  printDebugMsg('Start searching for new models');

  return Promise
    .try(() => session.get('https://showup.tv'))
    .then(response => cheerio.load(response.body))
    .then(($) => {
      const onlineModels = [];

      $('li[transcoderaddr][streamid]').each((i, e) => {
        // printDebugMsg(e);
        const $e = $(e);

        onlineModels.push({
          model: $e.find('.stream__meta h4').text(),
          streamServer: $e.attr('transcoderaddr'),
          playpath: $e.attr('streamid'),
        });
      });

      return onlineModels;
    })
    .then((onlineModels) => {
      const configModels = yaml.safeLoad(fs.readFileSync('config.yml', 'utf8')).models;

      return onlineModels.filter(o => configModels.find(m => m === o.model));
    })
    .then(modelsToCapture => modelsToCapture.filter(m => !captures.find(p => p.model === m.model)))
    .then(modelsToCapture => Promise.all(modelsToCapture.map(captureModel)))
    .then(() => Promise.all(captures.map(checkCapture)))
    .catch(printErrorMsg)
    .finally(() => {
      captures.forEach((c) => {
        printDebugMsg(colors.grey(c.proc.pid.toString().padEnd(12, ' ')), colors.grey(c.checkAfter), colors.grey(c.filename));
      });

      printMsg('Done, will search for new models in', config.modelScanInterval, 'second(s).');

      setTimeout(mainLoop, config.modelScanInterval * 1000);
    });
}

Promise
  .try(() => session.get('https://showup.tv/site/accept_rules?ref=https://showup.tv/'))
  .then(() => session.post('https://showup.tv/site/accept_rules?ref=https://showup.tv/', {
    decision: true,
  }, {
    referer: 'http://showup.tv/site/accept_rules?ref=http://showup.tv/site/log_in',
  }))
  .then(() => mkdirpAsync(captureDirectory))
  .then(() => mkdirpAsync(completeDirectory))
  .then(() => mainLoop())
  .catch((err) => {
    printErrorMsg(err.toString());
  });
