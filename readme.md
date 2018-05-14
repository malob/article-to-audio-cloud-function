# Article to Audio Google Cloud Function

This is a [Google Cloud Function](https://cloud.google.com/functions/) I hacked together that takes a url to an article on the web, and generates an audio file of it using Google's new [Cloud Text-To-Speech](https://cloud.google.com/text-to-speech/) API which has been updated with access to DeepMind's [WaveNet](https://deepmind.com/blog/wavenet-generative-model-raw-audio/) voices.

I created it as part of a project to generate a personal podcast of articles I want to consume. To get the full thing working see my other repository with the Cloud Function that generates the Podcast RSS.

## Sketch of how it works
  * The function accepts a POST request with json in the body.
    * E.g. `{"url": "http://example.com/somearticle"}`
  * It then uses the free [Mercury Web Parser](https://mercury.postlight.com/web-parser/) API to get the body of the article and some metadata.
  * Since the body is returned as HTML it then converts it to plain text. I also add some of the metadata at the top of the article, since I wanted this in the audio.
  * Then it slits up the body into chucks of no larger then 5,000 characters, since that's the limit on what the TTS API can handle per request.
  * From there is then sends each chuck of text to Google's TTS API which returns the audio encoded as MP3, and writes them to a temporary location.
  * Since having multiple files for parts of the article is annoying, it then uses FFMPEG to concatenate the audio chunks into one file.
  * Finally, it stores the audio file as and object in a Google Cloud Storage bucket, along with some of the metadata.

## Configuration details
To get this working you need a Google Cloud Project with a Cloud Storage bucket setup, and the Cloud Text-To-Speech API enabled.

You'll then need to create a new Cloud Function (see configuration details below), and replace the `undefined` global constants in the code, `gcpProjectID`, `gcpBucketName`, and `mercuryApiKey`, with the appropriate values.

### Cloud Function configuration
  * Trigger type: HTTP trigger
  * Memory allocated: 256 MB
  * Timeout: 240s
    * I had to extend this from default of 60s.