// ── Teams Capture – Offscreen Document ───────────────────────────────────────
// Mixes tab audio (other participants) + microphone (your voice) before recording.

let mediaRecorder = null;
let recordedChunks = [];
let tabStream      = null;
let micStream      = null;
let audioContext   = null;

// ── Start recording ───────────────────────────────────────────────────────────
async function startRecording(streamId, captureAudio) {
  try {
    // 1. Grab the tab stream (video + tab audio)
    const tabConstraints = {
      video: {
        mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId }
      },
      audio: captureAudio
        ? { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } }
        : false
    };

    tabStream = await navigator.mediaDevices.getUserMedia(tabConstraints);

    let streamToRecord = tabStream;

    // 2. If audio is enabled, also grab the microphone and mix both together
    if (captureAudio) {
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });

        // Use Web Audio API to mix tab audio + mic into a single stream
        audioContext = new AudioContext();

        const destination  = audioContext.createMediaStreamDestination();
        const tabSource    = audioContext.createMediaStreamSource(tabStream);
        const micSource    = audioContext.createMediaStreamSource(micStream);

        // Optional: give mic a slight gain boost so your voice isn't buried
        const micGain = audioContext.createGain();
        micGain.gain.value = 1.2;

        tabSource.connect(destination);
        micSource.connect(micGain);
        micGain.connect(destination);

        // Build a new combined stream: mixed audio + original video track
        const videoTrack    = tabStream.getVideoTracks()[0];
        const mixedAudio    = destination.stream.getAudioTracks()[0];
        streamToRecord      = new MediaStream([videoTrack, mixedAudio]);

        console.log('[TC Offscreen] Mic + tab audio mixed successfully');
      } catch (micErr) {
        // Mic access denied or unavailable — fall back to tab-only audio
        console.warn('[TC Offscreen] Mic unavailable, recording tab audio only:', micErr.message);
      }
    }

    // 3. Set up MediaRecorder on the combined stream
    recordedChunks = [];
    const mimeTypes = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ];
    const mimeType = mimeTypes.find(m => MediaRecorder.isTypeSupported(m)) || '';

    try {
      mediaRecorder = new MediaRecorder(streamToRecord, mimeType ? { mimeType } : {});
    } catch {
      mediaRecorder = new MediaRecorder(streamToRecord);
    }

    mediaRecorder.ondataavailable = (e) => {
      if (e.data?.size > 0) {
        recordedChunks.push(e.data);
        console.log(`[TC Offscreen] Chunk: ${e.data.size} bytes, total: ${recordedChunks.length}`);
      }
    };

    mediaRecorder.onstop = async () => {
      console.log(`[TC Offscreen] Stopped. Chunks: ${recordedChunks.length}`);

      if (!recordedChunks.length) {
        console.warn('[TC Offscreen] No chunks recorded!');
        chrome.runtime.sendMessage({ action: 'saveRecording', data: null, mimeType: '' });
        return;
      }

      const finalMimeType = mediaRecorder.mimeType || 'video/webm';
      const blob = new Blob(recordedChunks, { type: finalMimeType });
      console.log(`[TC Offscreen] Blob: ${blob.size} bytes, type: ${finalMimeType}`);
      recordedChunks = [];

      try {
        const arrayBuffer = await blob.arrayBuffer();
        const uint8Array  = new Uint8Array(arrayBuffer);

        let binary = '';
        const chunkSize = 8192;
        for (let i = 0; i < uint8Array.length; i += chunkSize) {
          binary += String.fromCharCode(...uint8Array.subarray(i, i + chunkSize));
        }

        chrome.runtime.sendMessage({
          action: 'saveRecording',
          data: btoa(binary),
          mimeType: finalMimeType
        }, (resp) => console.log('[TC Offscreen] saveRecording response:', resp));

      } catch (encodeErr) {
        console.error('[TC Offscreen] Encoding error:', encodeErr);
      }
    };

    mediaRecorder.onerror = (e) => console.error('[TC Offscreen] MediaRecorder error:', e.error);

    mediaRecorder.start(5000);
    console.log(`[TC Offscreen] Recording started. MIME: ${mediaRecorder.mimeType}`);
    return { success: true };

  } catch (err) {
    console.error('[TC Offscreen] startRecording error:', err);
    return { success: false, error: err.message };
  }
}

// ── Stop recording ────────────────────────────────────────────────────────────
function stopRecording() {
  try {
    console.log('[TC Offscreen] stopRecording. State:', mediaRecorder?.state);

    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }

    tabStream?.getTracks().forEach(t => t.stop());
    micStream?.getTracks().forEach(t => t.stop());
    audioContext?.close();

    tabStream = micStream = audioContext = null;
    return { success: true };
  } catch (err) {
    console.error('[TC Offscreen] stopRecording error:', err);
    return { success: false, error: err.message };
  }
}

// ── Message listener ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'offscreen_startRecording') {
    startRecording(msg.streamId, msg.captureAudio).then(sendResponse);
    return true;
  }
  if (msg.action === 'offscreen_stopRecording') {
    sendResponse(stopRecording());
    return false;
  }
});
