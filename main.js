'use strict';

var Promise = require('bluebird');
var fs = Promise.promisifyAll(require('fs'));
var childProcess = require('child_process');
var path = require('path');
var _ = require('underscore');
var bhttp = require('bhttp');
var cheerio = require('cheerio');
var colors = require('colors');
var mkdirp = require('mkdirp');
var moment = require('moment');
var yaml = require('js-yaml');
var WebSocketClient = require('websocket').client;
var mvAsync = Promise.promisify(require('mv'));

var session = bhttp.session();
var modelsCurrentlyCapturing = [];

var config = yaml.safeLoad(fs.readFileSync('config.yml', 'utf8'));

config.minFileSizeMb = config.minFileSizeMb || 0;

var captureDirectory = path.resolve(config.captureDirectory || './capture');
var completeDirectory = path.resolve(config.completeDirectory || './complete');

mkdirp(captureDirectory, (err) => {
  if (err) {
    printErrorMsg(err);
    process.exit(1);
  }
});

mkdirp(completeDirectory, (err) => {
  if (err) {
    printErrorMsg(err);
    process.exit(1);
  }
});

function getCurrentDateTime() {
  return moment().format('YYYY-MM-DDTHHmmss'); // The only true way of writing out dates and times, ISO 8601
}

function printMsg(...args) {
  console.log.apply(console, [colors.gray('[' + moment().format('MM/DD/YYYY - HH:mm:ss') + ']'), ...args]);
}

var printErrorMsg = printMsg.bind(printMsg, colors.red('[ERROR]'));
var printDebugMsg = config.debug ? printMsg.bind(printMsg, colors.yellow('[DEBUG]')) : () => {};

function getTimestamp() {
  return Math.floor(new Date().getTime() / 1000);
}

function dumpModelsCurrentlyCapturing() {
  _.each(modelsCurrentlyCapturing, (m) => {
    printDebugMsg(colors.red(m.pid) + '\t' + m.checkAfter + '\t' + m.filename);
  });
}

function login() {
  return Promise
    .try(() => session.get('http://showup.tv/site/accept_rules/yes?ref=http://showup.tv/site/log_in', {
      headers: {
        referer: 'http://showup.tv/site/accept_rules?ref=http://showup.tv/site/log_in'
      }
    }))
    .then(() => session.post('https://showup.tv/site/log_in?ref=http://showup.tv/TransList/fullList/lang/pl', {
      email: config.email,
      password: config.password,
      remember: '',
      submitLogin: 'Zaloguj'
    }, {
      headers: {
        referer: 'https://showup.tv/site/log_in'
      }
    }))
    .then((response) => {
      var $ = cheerio.load(response.body);
      var submitLogin = $('input[name="submitLogin"]').first().attr('name');

      if (submitLogin === 'submitLogin') {
        throw new Error('Failed to login');
      }
    })
    .timeout(15000, 'Failed to login');
}

function getOnlineFavouriteModels() {
  return Promise
    .try(() => session.get('http://showup.tv/site/favorites', {
      headers: {
        referer: 'http://showup.tv'
      }
    }))
    .then((response) => {
      var json = response.body;

      if (!json.list) {
        throw new Error('Failed to get favorite models');
      }

      var favouriteModels = _.chain(json.list.split(';'))
        .reject(m => !m)
        .map(m => m.split(','))
        .map(m => {
          return {
            uid: m[0],
            name: m[1]
          };
        })
        .value();

      var onlineFavouriteModels = _.reject(favouriteModels, m => !json.online.find(o => (o.uid === m.uid)));

      printDebugMsg('Found these favorite models: ' + _.map(onlineFavouriteModels, m => m.name).join(', '));

      return onlineFavouriteModels;
    })
    .timeout(15000, 'Failed to get favourite models');
}

function getCommandArguments(model) {
  return Promise
    .try(() => session.get('http://showup.tv/' + model.name))
    .then((response) => {
      var rawHTML = response.body.toString('utf8');

      var startChildBug = rawHTML.match(/startChildBug\(user\.uid, '([\s\S]+?)', '([\s\S]+?)'/);

      if (!startChildBug || !startChildBug[1] || !startChildBug[2]) {
        throw new Error('startChildBug is unavailable');
      }

      let csrf = startChildBug[1];
      let wsUrl = startChildBug[2];

      printMsg(csrf, wsUrl);

      var user = rawHTML.match(/var user = new User\(([\s\S]+?),/);

      if (!user || !user[1]) {
        throw new Error('User\'s uid is unavailable');
      }

      let userUid = user[1];

      printMsg(userUid);


      return new Promise((resolve, reject) => {
        var client = new WebSocketClient();
        var commandArguments = {};

        client.on('connectFailed', (err) => {
          reject(err);
        });

        client.on('connect', (connection) => {
          connection.on('error', (err) => {
            reject(err);
          });

          connection.on('message', (message) => {
            if (message.type === 'utf8') {
              var json = JSON.parse(message.utf8Data);

              if (json.id === 143 && json.value[0] === '0') {
                // printDebugMsg('Logged in');
              }

              if (json.id === 102 && json.value[0]) {
                if (json.value[0] === 'failure') {
                  connection.close();

                  reject('Model might be offline');
                } else if (json.value[0] === 'alreadyJoined') {
                  connection.close();

                  reject('Another stream of this model exists');
                } else {
                  commandArguments.streamServer = json.value[1];

                  if (commandArguments.playpath) {
                    connection.close();

                    resolve(commandArguments);
                  }
                }
              }

              if (json.id === 103 && json.value[0]) {
                commandArguments.playpath = json.value[0] + '_aac';

                if (commandArguments.streamServer) {
                  connection.close();

                  resolve(commandArguments);
                }
              }
            }
          });

          connection.sendUTF(`{ "id": 0, "value": [${userUid}, "${csrf}"]}`);
          connection.sendUTF(`{ "id": 2, "value": ["${model.name}"]}`);
        });

        client.connect(`ws://${wsUrl}`, '');
      });
    })
    .timeout(15000);
}

function createCaptureProcess(model) {
  var capturingModel = _.findWhere(modelsCurrentlyCapturing, { modelName: model.name });

  if (!_.isUndefined(capturingModel)) {
    printDebugMsg(colors.green(model.name) + ' is already capturing');
    return; // resolve immediately
  }

  return Promise
    .try(() => {
      return getCommandArguments(model);
    }).then((commandArguments) => {
      printMsg(colors.green(model.name) + ' is now online, starting rtmpdump process');

      var filename = model.name + '_' + getCurrentDateTime() + '.flv';

      var spawnArguments = [
        '--live',
        config.rtmpDebug ? '' : '--quiet',
        '--rtmp', `rtmp://${commandArguments.streamServer}:1935/webrtc`,
        '--playpath', commandArguments.playpath,
        '--flv', captureDirectory + '/' + filename
      ];

      printDebugMsg(spawnArguments);

      var captureProcess = childProcess.spawn('rtmpdump', spawnArguments);

      captureProcess.stdout.on('data', (data) => {
        printMsg(data.toString());
      });

      captureProcess.stderr.on('data', (data) => {
        printMsg(data.toString());
      });

      captureProcess.on('close', (code) => {
        printMsg(colors.green(model.name) + ' stopped streaming');

        var stoppedModel = _.findWhere(modelsCurrentlyCapturing, { pid: captureProcess.pid });

        if (!_.isUndefined(stoppedModel)) {
          var modelIndex = modelsCurrentlyCapturing.indexOf(stoppedModel);

          if (modelIndex !== -1) {
            modelsCurrentlyCapturing.splice(modelIndex, 1);
          }
        }

        let src = captureDirectory + '/' + filename;
        let dst = completeDirectory + '/' + filename;

        fs.statAsync(src)
          // if the file is big enough we keep it otherwise we delete it
          .then(stats => (stats.size <= config.minFileSizeMb * 1048576) ? fs.unlinkAsync(src) : mvAsync(src, dst, { mkdirp: true }))
          .catch(err => {
            if (err.code !== 'ENOENT') {
              printErrorMsg('[' + colors.green(model.name) + '] ' + err.toString());
            }
          });
      });

      if (!_.isUndefined(captureProcess.pid)) {
        modelsCurrentlyCapturing.push({
          modelName: model.name,
          filename: filename,
          captureProcess: captureProcess,
          pid: captureProcess.pid,
          checkAfter: getTimestamp() + 60, // we are gonna check the process after 60 seconds
          size: 0
        });
      }
    })
    .catch((err) => {
      printErrorMsg('[' + colors.green(model.name) + '] ' + err.toString());
    });
}

function checkCaptureProcess(model) {
  if (!model.checkAfter || model.checkAfter > getTimestamp()) {
    // if this is not the time to check the process then we resolve immediately
    printDebugMsg(colors.green(model.modelName) + ' - OK');
    return;
  }

  printDebugMsg(colors.green(model.modelName) + ' should be checked');

  return fs
    .statAsync(captureDirectory + '/' + model.filename)
    .then((stats) => {
      // we check the process after 60 seconds since the its start,
      // then we check it every 10 minutes,
      // if the size of the file has not changed over the time, we kill the process
      if (stats.size - model.size > 0) {
        printDebugMsg(colors.green(model.modelName) + ' - OK');

        model.checkAfter = getTimestamp() + 600; // 10 minutes
        model.size = stats.size;
      } else if (!_.isUndefined(model.captureProcess)) {
        // we assume that onClose will do clean up for us
        printErrorMsg('[' + colors.green(model.modelName) + '] Process is dead');
        model.captureProcess.kill();
      } else {
        // suppose here we should forcefully remove the model from modelsCurrentlyCapturing
        // because her captureProcess is unset, but let's leave this as is
      }
    })
    .catch((err) => {
      if (err.code === 'ENOENT') {
        // do nothing, file does not exists,
        // this is kind of impossible case, however, probably there should be some code to "clean up" the process
      } else {
        printErrorMsg('[' + colors.green(model.modelName) + '] ' + err.toString());
      }
    });
}

function mainLoop() {
  printDebugMsg('Start searching for new models');

  Promise
    .try(() => login())
    .then(() => getOnlineFavouriteModels())
    .then((onlineFavouriteModels) => Promise.all(onlineFavouriteModels.map(createCaptureProcess)))
    .then(() => Promise.all(modelsCurrentlyCapturing.map(checkCaptureProcess)))
    .catch((err) => {
      printErrorMsg(err);
    })
    .finally(() => {
      dumpModelsCurrentlyCapturing();

      printMsg('Done, will search for new models in ' + config.modelScanInterval + ' second(s).');

      setTimeout(mainLoop, config.modelScanInterval * 1000);
    });
}

mainLoop();
