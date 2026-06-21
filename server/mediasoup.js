const mediasoup = require("mediasoup");

let worker;
let router;

async function createWorker() {
  worker = await mediasoup.createWorker();
  router = await worker.createRouter({
    mediaCodecs: [
      {
        kind: "audio",
        mimeType: "audio/opus",
        clockRate: 48000,
        channels: 2,
      },
      {
        kind: "video",
        mimeType: "video/VP8",
        clockRate: 90000,
      },
    ],
  });
}

function getRouter() {
  return router;
}

module.exports = { createWorker, getRouter };
