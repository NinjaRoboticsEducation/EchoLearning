import React, { useEffect, useRef, useState } from 'react';
import {
  Pause,
  Play,
  Repeat,
  RotateCcw,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
} from 'lucide-react';

declare global {
  interface Window {
    YT: any;
    onYouTubeIframeAPIReady?: () => void;
  }
}

export interface YouTubePlayerHandle {
  seekTo: (seconds: number, allowSeekAhead?: boolean) => void;
  play: () => void;
  pause: () => void;
  getCurrentTime: () => number;
  getDuration: () => number;
  setPlaybackRate: (rate: number) => void;
}

interface YouTubePlayerProps {
  videoId: string;
  currentTime: number;
  isPlaying: boolean;
  playbackRate: number;
  loopSegment: { startTime: number; endTime: number } | null;
  autoPauseAtSec: number | null;
  onTimeUpdate: (timeSec: number) => void;
  onPlayStateChange: (playing: boolean) => void;
  onPlaybackRateChange: (rate: number) => void;
  onToggleLoopSegment: () => void;
  onPrevSegment: () => void;
  onNextSegment: () => void;
  onAutoPauseReached?: () => void;
  playerRefOut: React.MutableRefObject<YouTubePlayerHandle | null>;
}

let ytApiPromise: Promise<void> | null = null;

function loadYouTubeIframeApi(): Promise<void> {
  if (window.YT && window.YT.Player) {
    return Promise.resolve();
  }
  if (ytApiPromise) {
    return ytApiPromise;
  }
  ytApiPromise = new Promise<void>((resolve) => {
    const existingScript = document.querySelector(
      'script[src="https://www.youtube.com/iframe_api"]'
    );
    const prevCallback = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (prevCallback) prevCallback();
      resolve();
    };
    if (!existingScript) {
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      tag.async = true;
      document.head.appendChild(tag);
    }
  });
  return ytApiPromise;
}

export function formatTimestamp(sec: number): string {
  const safe = Math.max(0, Number.isFinite(sec) ? sec : 0);
  const mins = Math.floor(safe / 60);
  const secs = Math.floor(safe % 60);
  const tenths = Math.floor((safe % 1) * 10);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(
    2,
    '0'
  )}.${tenths}`;
}

export const YouTubePlayer: React.FC<YouTubePlayerProps> = ({
  videoId,
  currentTime,
  isPlaying,
  playbackRate,
  loopSegment,
  autoPauseAtSec,
  onTimeUpdate,
  onPlayStateChange,
  onPlaybackRateChange,
  onToggleLoopSegment,
  onPrevSegment,
  onNextSegment,
  onAutoPauseReached,
  playerRefOut,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const ytPlayerRef = useRef<any>(null);
  const loadedVideoIdRef = useRef<string | null>(null);
  const lastReportedTimeRef = useRef<number>(-1);

  const [rates, setRates] = useState<number[]>([1]);
  const [isReady, setIsReady] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [playerError, setPlayerError] = useState<string | null>(null);

  // Keep latest callbacks in refs so the 80ms sync interval always sees current props
  const loopSegmentRef = useRef(loopSegment);
  loopSegmentRef.current = loopSegment;

  const autoPauseRef = useRef<number | null>(autoPauseAtSec);
  useEffect(() => {
    autoPauseRef.current = autoPauseAtSec;
  }, [autoPauseAtSec]);

  const onTimeUpdateRef = useRef(onTimeUpdate);
  onTimeUpdateRef.current = onTimeUpdate;

  const onPlayStateChangeRef = useRef(onPlayStateChange);
  onPlayStateChangeRef.current = onPlayStateChange;

  const onAutoPauseReachedRef = useRef(onAutoPauseReached);
  onAutoPauseReachedRef.current = onAutoPauseReached;

  useEffect(() => {
    let isMounted = true;
    setPlayerError(null);

    loadYouTubeIframeApi().then(() => {
      if (!isMounted || !containerRef.current) return;

      if (
        ytPlayerRef.current &&
        typeof ytPlayerRef.current.loadVideoById === 'function'
      ) {
        if (loadedVideoIdRef.current !== videoId) {
          loadedVideoIdRef.current = videoId;
          ytPlayerRef.current.cueVideoById(videoId);
        }
        return;
      }

      loadedVideoIdRef.current = videoId;
      ytPlayerRef.current = new window.YT.Player(containerRef.current, {
        videoId,
        width: '100%',
        height: '100%',
        playerVars: {
          autoplay: 0,
          controls: 1,
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
          cc_load_policy: 0,
        },
        events: {
          onReady: (event: any) => {
            if (!isMounted) return;
            setIsReady(true);
            setRates(event.target.getAvailablePlaybackRates?.() ?? [1]);
            onPlaybackRateChange(event.target.getPlaybackRate?.() ?? 1);
            playerRefOut.current = {
              seekTo: (seconds: number, allowSeekAhead = true) => {
                if (ytPlayerRef.current?.seekTo) {
                  ytPlayerRef.current.seekTo(seconds, allowSeekAhead);
                  lastReportedTimeRef.current = seconds;
                  onTimeUpdateRef.current(seconds);
                }
              },
              play: () => {
                ytPlayerRef.current?.playVideo?.();
              },
              pause: () => {
                ytPlayerRef.current?.pauseVideo?.();
              },
              getCurrentTime: () => {
                return ytPlayerRef.current?.getCurrentTime?.() || 0;
              },
              getDuration: () => {
                return ytPlayerRef.current?.getDuration?.() || 0;
              },
              setPlaybackRate: (rate: number) => {
                ytPlayerRef.current?.setPlaybackRate?.(rate);
              },
            };
          },
          onPlaybackRateChange: (event: any) => {
            if (isMounted) onPlaybackRateChange(event.data);
          },
          onStateChange: (event: any) => {
            if (!isMounted) return;
            const YTState = window.YT?.PlayerState;
            if (!YTState) return;
            if (event.data === YTState.CUED || event.data === YTState.PLAYING) {
              setRates(event.target.getAvailablePlaybackRates?.() ?? [1]);
              onPlaybackRateChange(event.target.getPlaybackRate?.() ?? 1);
            }
            if (event.data === YTState.PLAYING) {
              onPlayStateChangeRef.current(true);
            } else if (
              event.data === YTState.PAUSED ||
              event.data === YTState.ENDED ||
              event.data === YTState.CUED
            ) {
              onPlayStateChangeRef.current(false);
            }
          },
          onError: () => {
            if (!isMounted) return;
            setPlayerError(
              'This YouTube video restricts embedded playback or is unavailable. You can still use the interactive transcript, dictionary, and shadowing recorder below.'
            );
          },
        },
      });
    });

    return () => {
      isMounted = false;
    };
  }, [videoId]);

  // High-precision 80ms polling interval for sentence sync, A-B loop, and single-shot Listen-Then-Repeat auto-pause
  useEffect(() => {
    if (!isReady) return;
    const interval = window.setInterval(() => {
      const player = ytPlayerRef.current;
      if (!player || typeof player.getCurrentTime !== 'function') return;
      const state = player.getPlayerState?.();
      if (state === window.YT?.PlayerState?.PLAYING) {
        const t = player.getCurrentTime();
        if (typeof t === 'number' && !Number.isNaN(t)) {
          // Only trigger React state update when playback time changes by >= 0.16s to keep continuous playback silky-smooth
          if (Math.abs(t - lastReportedTimeRef.current) >= 0.16) {
            lastReportedTimeRef.current = t;
            onTimeUpdateRef.current(t);
          }

          // Check single-shot Listen-Then-Repeat auto-pause boundary
          if (
            autoPauseRef.current !== null &&
            t >= autoPauseRef.current - 0.08
          ) {
            // Immediately consume & clear autoPauseRef so it NEVER repeatedly pauses continuous playback!
            autoPauseRef.current = null;
            player.pauseVideo();
            onPlayStateChangeRef.current(false);
            if (onAutoPauseReachedRef.current) {
              onAutoPauseReachedRef.current();
            }
            return;
          }

          // Check A-B segment loop boundary
          if (
            loopSegmentRef.current &&
            t >= loopSegmentRef.current.endTime - 0.05
          ) {
            player.seekTo(loopSegmentRef.current.startTime, true);
            lastReportedTimeRef.current = loopSegmentRef.current.startTime;
            onTimeUpdateRef.current(loopSegmentRef.current.startTime);
          }
        }
      }
    }, 80);

    return () => window.clearInterval(interval);
  }, [isReady]);

  const handleTogglePlay = () => {
    const player = ytPlayerRef.current;
    if (!player || !isReady) return;
    if (isPlaying) {
      player.pauseVideo();
    } else {
      // Clear any leftover single-shot auto-pause when user manually plays
      autoPauseRef.current = null;
      player.playVideo();
    }
  };

  const handleReplaySegment = () => {
    const player = ytPlayerRef.current;
    if (!player || !isReady) return;
    const targetTime = loopSegment
      ? loopSegment.startTime
      : Math.max(0, currentTime - 4);
    player.seekTo(targetTime, true);
    player.playVideo();
    lastReportedTimeRef.current = targetTime;
    onTimeUpdate(targetTime);
  };

  const handleToggleMute = () => {
    const player = ytPlayerRef.current;
    if (!player || !isReady) return;
    if (isMuted) {
      player.unMute?.();
      setIsMuted(false);
    } else {
      player.mute?.();
      setIsMuted(true);
    }
  };

  const handleRateChange = (rate: number) => {
    ytPlayerRef.current?.setPlaybackRate?.(rate);
  };


  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
      {/* 16:9 Embedded Video Container */}
      <div className="relative aspect-video w-full bg-slate-950">
        <div ref={containerRef} className="w-full h-full" />
        {playerError && (
          <div className="absolute inset-0 bg-slate-900/90 flex items-center justify-center p-6 text-center">
            <p className="text-sm text-slate-200 max-w-md">{playerError}</p>
          </div>
        )}
      </div>

      {/* Synchronized Transport & Loop Deck */}
      <div className="px-4 py-3 bg-slate-50 border-t border-slate-200 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onPrevSegment}
            title="Previous Sentence Segment"
            className="p-2 text-slate-700 hover:text-slate-950 hover:bg-slate-200/70 rounded-lg transition-colors cursor-pointer"
          >
            <SkipBack className="w-4 h-4" />
          </button>

          <button
            type="button"
            onClick={handleTogglePlay}
            className="flex items-center gap-2 px-4 py-2 bg-sky-600 hover:bg-sky-700 text-white text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {isPlaying ? (
              <Pause className="w-3.5 h-3.5" />
            ) : (
              <Play className="w-3.5 h-3.5" />
            )}
            <span>{isPlaying ? 'Pause Video' : 'Play Video'}</span>
          </button>

          <button
            type="button"
            onClick={onNextSegment}
            title="Next Sentence Segment"
            className="p-2 text-slate-700 hover:text-slate-950 hover:bg-slate-200/70 rounded-lg transition-colors cursor-pointer"
          >
            <SkipForward className="w-4 h-4" />
          </button>

          <button
            type="button"
            onClick={handleReplaySegment}
            title="Replay Current Segment"
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:text-slate-950 hover:bg-slate-200/70 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Replay</span>
          </button>

          <button
            type="button"
            onClick={onToggleLoopSegment}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              loopSegment
                ? 'bg-sky-100 text-sky-900 border border-sky-300'
                : 'text-slate-700 hover:text-slate-950 hover:bg-slate-200/70'
            }`}
          >
            <Repeat className="w-3.5 h-3.5" />
            <span>{loopSegment ? 'Looping Segment' : 'Loop Segment'}</span>
          </button>
        </div>

        <div className="flex items-center gap-3">
          {/* Timestamp Readout */}
          <div className="text-xs font-mono-tabular text-slate-600">
            <span>{formatTimestamp(currentTime)}</span>
          </div>

          <span className="text-slate-300" aria-hidden="true">
            ·
          </span>

          {/* Speed Control */}
          <div className="flex items-center gap-1 bg-slate-200/70 p-0.5 rounded-lg">
            {rates.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => handleRateChange(r)}
                className={`px-2 py-1 text-xs font-mono-tabular rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  Math.abs(playbackRate - r) < 0.01
                    ? 'bg-white text-slate-900 font-semibold shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {r}x
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={handleToggleMute}
            title={
              isMuted
                ? 'Unmute Video'
                : 'Mute Video (For Quiet Shadowing)'
            }
            className="p-1.5 text-slate-600 hover:text-slate-900 rounded-lg transition-colors cursor-pointer"
          >
            {isMuted ? (
              <VolumeX className="w-4 h-4 text-amber-600" />
            ) : (
              <Volume2 className="w-4 h-4" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
