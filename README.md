showuptv-node
==========

showuptv-node lets you follow and archive your favorite models' shows on showup.tv

Requirements
==========
[RTMPDump(ksv)](https://github.com/BurntSushi/rtmpdump-ksv) used to capture the streams.

[Node.js](https://nodejs.org/download/) used to run showuptv-node, hence the name.

[ffmpeg](https://www.ffmpeg.org/download.html) compiled with support for `libmp3lame` & `libspeex` audio for converting the output files.

Donate
===========
You can help me to improve this script by [buying me a coffee](https://ko-fi.com/A320FTJ).

Setup
===========

Install requirements, run `npm install` in the same folder as main.js is. Add models you want to capture to config.yml file.

Running & Output
===========

To start capturing streams you need to run `node main.js` I recommend you do this in [screen](https://www.gnu.org/software/screen/) as that'll keep running if you lose connection to the machine or otherwise close your shell.

Converting
===========

There is a simple script to convert `.flv` files. Just edit `convert.yml` file and set proper values for `srcDirectory` (should be the same with `completeDirectory`) and `dstDirectory`, and run `node convert.js` in separate console window.

> Note for Windows users: You should copy `ffmpeg.exe` file into the same directory as `main.js` is.