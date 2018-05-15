// Node libraries
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Google APIs
const TextToSpeech = require('@google-cloud/text-to-speech');
const Storage = require('@google-cloud/storage');

// Other packages
const request = require('request');
const htmlToText = require('html-to-text');
const chunkText = require('chunk-text');
const async = require('async');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const ffprobeStatic = require('ffprobe-static');

// Global constants [FILL ME IT!]
const workingDir = os.tmpdir(); // Change this if running locally
const gcpProjectId = undefined;
const gcpBucketName = undefined;
const mercuryApiKey = undefined;

exports.articleToAudio = (req, res) => {
  if (req.body.url === undefined) {
    res.status(400).send('No url provided!');
  } else {
    cleanWorkingDir((err) => {
      getArticleData(req.body.url, (err, articleData) => {
        if (err) { res.status(400).send('Something went wrong while fetching article data.\n' + err); }
        else {
          articleData.content = chunkText(articleData.content, 5000);
          async.map(articleData.content, getTtsAudio, (err, audio) => {
            if (err) { res.status(400).send('TTS conversion failed.\n' + err); }
            else {
              async.eachOf(audio, writeAudioFiles, (err) => {
                if (err) { res.status(400).send('Failed to write audio segment(s) to disk.\n' + err); }
                else {
                  fs.readdir(workingDir, (err, fileNames) => {
                    fileNames.sort();
                    let filePaths = fileNames.map((x) => { return path.join(workingDir, x); });
                    concatAudioFiles(filePaths, (err, singleFilePath) => {
                      if (err) { res.status(400).send('Failed to concatinate audio files.\n' + err); }
                      else {
                        createGcsObject(articleData, singleFilePath, (err, metadata) => {
                          if (err) { res.status(400).send('Could not send audio to GCS.\n' + err); }
                          else {
                            res.status(200).send('File successfully sent to GCS:\n' + metadata);
                          }
                        });
                      }
                    });
                  });
                }
              });
            }
          });
        }
      });
    });
  }
};

// Used to make sure the working directory is clean before starting
function cleanWorkingDir(cb) {
  fs.readdir(workingDir, (err, fileNames) => {
    if (fileNames) {
      filePaths = fileNames.map((x) => { return path.join(workingDir, x); });
      async.forEach(filePaths, fs.unlink, (err) => { cb(err); });
    } else {
      cb();
    }
  });
}

// Uses Mercury Parser API to retrieve article data including content
// then does some processing of the data.
// Mercury API documentation: https://mercury.postlight.com/web-parser/
function getArticleData(url, cb) {
  // API request setup
  const reqOptions = {
    url: 'https://mercury.postlight.com/parser?url=' + url,
    json: true,
    headers: { 'x-api-key': mercuryApiKey }
  };

  // Mercury API returns article content as HTML, so I use html-to-text to
  // to convert the HTML to plain text.
  const htmlToTextOptions = {
    wordwrap: null,
    ignoreHref: true,
    ignoreImage: true,
    preserveNewlines: false,
    uppercaseHeadings: false,
    singleNewLineParagraphs: false
  };

  request.get(reqOptions, (err, res, body) => {
    if (err) {
      cb(err, null);
    } else if (res.statusCode != 200) {
      cb('Mercury Parser experienced and issue.', null);
    } else if (!body.content || !body.title) {
      cb('Mercury Parser could not find or process the article body.', null);
    } else {
      // Convert content to plain text
      body.content = htmlToText.fromString(body.content, htmlToTextOptions);

      // Add some of the article metadata to the content
      if (body.domain) { body.content = 'Published at: ' + body.domain + '\n\n' + body.content; }
      if (body.date_published) {
        const date = new Date(body.date_published);
        body.content = 'Published on: ' + date.toDateString() + '\n\n' + body.content;
      }
      if (body.author) { body.content = 'By: ' + body.author + '\n\n' + body.content; }
      if (body.title) { body.content = body.title + '\n\n' + body.content; }

      cb(null, body);
    }
  });
}

// Uses Googles Text-To-Speech API to generate audio from text
function getTtsAudio(str, cb) {
  const ttsClient = new TextToSpeech.TextToSpeechClient();
  const ttsRequest = {
    input: { text: str },
    voice: { languageCode: 'en-US', name: 'en-US-Wavenet-F', ssmlGender: 'FEMALE' },
    audioConfig: { audioEncoding: 'MP3' },
  };

  ttsClient.synthesizeSpeech(ttsRequest, (err, res) => {
    if (err) { cb(err, null); }
    else { cb(null, res.audioContent); }
  });
}

// Used to write audioData to disk before concatinating with ffmpeg
function writeAudioFiles(audioData, key, cb) {
  key = key + 1000; // To make sorting of files easier later
  filePath = path.join(workingDir, key + '.mp3');
  fs.writeFile(filePath, audioData, 'binary', (err) => {
    if (err) { cb(err); }
    else { cb(null); }
  });
}

// Used to concatinate audio files with ffmpeg and retunrs the path to the concatinated file
function concatAudioFiles(filePaths, cb) {
  if (filePaths.length == 1) { cb(null, filePaths[0]); }
  else {
    var ffmpegCmd = ffmpeg();
    const singleFilePath = path.join(workingDir, 'article.mp3');

    filePaths.forEach((x) => { ffmpegCmd.input(x); });

    ffmpegCmd
      .setFfmpegPath(ffmpegStatic.path)
      .setFfprobePath(ffprobeStatic.path)
      .on('error', (err) => { cb(err, null); })
      .on('end', () => { cb(null, singleFilePath); })
      .mergeToFile(singleFilePath, workingDir);
  }
}

// Used to send concatinated audio file to Google Cloud Storage
function createGcsObject(articleData, audioPath, cb) {
  const storage = new Storage({ projectId: gcpProjectId });

  // Hash article URL to to use as Object name
  var hash = crypto.createHash('md5').update(articleData.url).digest('hex');

  const objectOptions = {
    destination: hash + '.mp3',
    public: true,
    metadata: {
      contentType: 'audio/mpeg',
      metadata: {
        title: articleData.title,
        author: articleData.author,
        excerpt: articleData.excerpt,
        url: articleData.url,
        datePublished: articleData.date_published,
        leadImageUrl: articleData.lead_image_url
      }
    }
  };

  storage
    .bucket(gcpBucketName)
    .upload(audioPath, objectOptions, (err, metadata, apiResponse) => {
      if (err) { cb(err, null); }
      else { cb(null, metadata); }
    });
}