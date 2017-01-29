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

function printMsg(msg) {
  console.log(colors.blue('[' + getCurrentDateTime() + ']'), msg);
}

function printErrorMsg(msg) {
  console.log(colors.blue('[' + getCurrentDateTime() + ']'), colors.red('[ERROR]'), msg);
}

function printDebugMsg(msg) {
  if (config.debug && msg) {
    console.log(colors.blue('[' + getCurrentDateTime() + ']'), colors.yellow('[DEBUG]'), msg);
  }
}

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

function getFavouriteModels() {
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

      var favouriteModels = _.chain(json.list.split(';')).reject(m => !m).map(m => m.split(',')[1]).value();

      printDebugMsg('Found these favorite models: ' + favouriteModels.join(', '));

      return favouriteModels;
    })
    .timeout(15000, 'Failed to get favourite models');
}

function domainToIp(s) {
  var ip = '';
  var t = s.split(':');

  if (t[0] === 'j12.showup.tv') {
    ip = '94.23.171.122';
  } else if (t[0] === 'j13.showup.tv') {
    ip = '94.23.171.121';
  } else if (t[0] === 'j11.showup.tv') {
    ip = '94.23.171.115';
  } else if (t[0] === 'j14.showup.tv') {
    ip = '94.23.171.120';
  }

  return !ip ? `ws://${s}` : `ws://${ip}:${t[1]}`;
}

function getCommandArguments(modelName) {
  return Promise
    .try(() => session.get('http://showup.tv/' + modelName))
    .then((response) => {
      var rawHTML = response.body.toString('utf8');

      var streamData = rawHTML.match(/'rtmp:\/\/([\s\S]+?)\/liveedge'/);

      if (!streamData || !streamData[1]) {
        throw new Error('streamData is unavailable');
      }

      var streamServer = streamData[1];

      var user = rawHTML.match(/var user = new User\(([\s\S]+?),/);

      if (!user || !user[1]) {
        throw new Error('streamServer is unavailable');
      }

      var wsUID = user[1];

      var startChildBug = rawHTML.match(/startChildBug\(user\.uid, '([\s\S]+?)', '([\s\S]+?)'/);

      if (!startChildBug || !startChildBug[1] || !startChildBug[2]) {
        throw new Error('startChildBug is unavailable');
      }

      var wsPassword = startChildBug[1];
      var serverAddr = startChildBug[2];

      if (!wsPassword) {
        throw new Error('wsPassword is unavailable');
      }

      if (!serverAddr) {
        throw new Error('serverAddr is unavailable');
      }

      var wsUrl = domainToIp(serverAddr);

      // printDebugMsg(streamServer);
      // printDebugMsg(wsUID);
      // printDebugMsg(wsPassword);
      // printDebugMsg(wsUrl);

      return new Promise((resolve, reject) => {
        var client = new WebSocketClient();

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
                }
              }

              if (json.id === 103 && json.value[0]) {
                connection.close();

                resolve({
                  streamServer: streamServer,
                  playpath: json.value[0]
                });
              }
            }
          });

          connection.sendUTF(`{ "id": 0, "value": [${wsUID}, "${wsPassword}"]}`);
          connection.sendUTF(`{ "id": 2, "value": ["${modelName}"]}`);
        });

        client.connect(wsUrl, '');
      });
    })
    .timeout(15000);
}

function createCaptureProcess(modelName) {
  var model = _.findWhere(modelsCurrentlyCapturing, { modelName: modelName });

  if (!_.isUndefined(model)) {
    printDebugMsg(colors.green(modelName) + ' is already capturing');
    return; // resolve immediately
  }

  return Promise
    .try(() => {
      return getCommandArguments(modelName);
    }).then((commandArguments) => {
      printMsg(colors.green(modelName) + ' is now online, starting rtmpdump process');

      var filename = modelName + '_' + getCurrentDateTime() + '.flv';

      var spawnArguments = [
        '--live',
        '-a',
        'liveedge',
        config.rtmpDebug ? '' : '--quiet',
        '-s',
        'http://showup.tv/flash/suStreamer.swf',
        '--rtmp',
        `rtmp://${commandArguments.streamServer}/liveedge`,
        '--pageUrl',
        'http://showup.tv/' + modelName,
        '--playpath',
        commandArguments.playpath,
        '--flv',
        captureDirectory + '/' + filename
      ];

      // printDebugMsg(spawnArguments);

      var captureProcess = childProcess.spawn('rtmpdump', spawnArguments);

      captureProcess.stdout.on('data', (data) => {
        printMsg(data.toString);
      });

      captureProcess.stderr.on('data', (data) => {
        printMsg(data.toString);
      });

      captureProcess.on('close', (code) => {
        printMsg(colors.green(modelName) + ' stopped streaming');

        var stoppedModel = _.findWhere(modelsCurrentlyCapturing, { pid: captureProcess.pid });

        if (!_.isUndefined(stoppedModel)) {
          var modelIndex = modelsCurrentlyCapturing.indexOf(stoppedModel);

          if (modelIndex !== -1) {
            modelsCurrentlyCapturing.splice(modelIndex, 1);
          }
        }

        fs.stat(captureDirectory + '/' + filename, (err, stats) => {
          if (err) {
            if (err.code === 'ENOENT') {
              // do nothing, file does not exists
            } else {
              printErrorMsg('[' + colors.green(modelName) + '] ' + err.toString());
            }
          } else if (stats.size === 0 || stats.size < (config.minFileSizeMb * 1048576)) {
            fs.unlink(captureDirectory + '/' + filename, (e) => {
              // do nothing, shit happens
            });
          } else {
            fs.rename(captureDirectory + '/' + filename, completeDirectory + '/' + filename, (e) => {
              if (e) {
                printErrorMsg('[' + colors.green(modelName) + '] ' + err.toString());
              }
            });
          }
        });
      });

      if (!_.isUndefined(captureProcess.pid)) {
        modelsCurrentlyCapturing.push({
          modelName: modelName,
          filename: filename,
          captureProcess: captureProcess,
          pid: captureProcess.pid,
          checkAfter: getTimestamp() + 60, // we are gonna check the process after 60 seconds
          size: 0
        });
      }
    })
    .catch((err) => {
      printErrorMsg('[' + colors.green(modelName) + '] ' + err.toString());
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
    .then(() => getFavouriteModels())
    .then((favouriteModels) => Promise.all(favouriteModels.map(createCaptureProcess)))
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
