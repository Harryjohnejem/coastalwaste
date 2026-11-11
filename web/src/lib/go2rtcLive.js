/** Lowest-latency go2rtc path: WebRTC (sub-second). MSE MP4 is the fallback. */

export function go2rtcSrcFromUrl(url) {
  if (!url) return null;
  try {
    return new URL(url, window.location.origin).searchParams.get('src');
  } catch {
    return null;
  }
}

export function webrtcUrlForSrc(src) {
  return `/go2rtc/api/webrtc?src=${encodeURIComponent(src)}`;
}

/**
 * Play go2rtc camera via WebRTC into a <video>. Returns RTCPeerConnection.
 * POST /api/webrtc with SDP offer (go2rtc 1.8+).
 */
export async function playGo2rtcWebRtc(video, src, { timeoutMs = 4000 } = {}) {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  });
  const media = new MediaStream();
  video.srcObject = media;
  video.removeAttribute('src');

  let trackTimer;
  const firstTrack = new Promise((resolve, reject) => {
    trackTimer = setTimeout(() => reject(new Error('webrtc no track')), timeoutMs + 1500);
    pc.ontrack = (ev) => {
      const track = ev.track;
      if (track && !media.getTracks().some((t) => t.id === track.id)) {
        media.addTrack(track);
      }
      clearTimeout(trackTimer);
      resolve();
    };
  });

  try {
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    await new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') {
        resolve();
        return;
      }
      const onState = () => {
        if (pc.iceGatheringState === 'complete') {
          pc.removeEventListener('icegatheringstatechange', onState);
          resolve();
        }
      };
      pc.addEventListener('icegatheringstatechange', onState);
      setTimeout(() => {
        pc.removeEventListener('icegatheringstatechange', onState);
        resolve();
      }, 800);
    });

    const localSdp = pc.localDescription?.sdp || offer.sdp;

    const res = await Promise.race([
      fetch(webrtcUrlForSrc(src), {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp' },
        body: localSdp,
      }),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('webrtc timeout')), timeoutMs);
      }),
    ]);

    if (!res.ok) {
      throw new Error(`webrtc ${res.status}`);
    }

    const answer = await res.text();
    await pc.setRemoteDescription({ type: 'answer', sdp: answer });
    await firstTrack;
    await video.play();
    return pc;
  } catch (err) {
    clearTimeout(trackTimer);
    try {
      pc.close();
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/** Jump MSE playback to the live edge so fMP4 does not sit several seconds behind. */
export function catchUpLive(video, maxLag = 0.4) {
  if (!video || video.srcObject) return;
  try {
    if (!video.buffered.length) return;
    const end = video.buffered.end(video.buffered.length - 1);
    if (end - video.currentTime > maxLag) {
      video.currentTime = Math.max(0, end - 0.08);
    }
  } catch {
    /* ignore */
  }
}
