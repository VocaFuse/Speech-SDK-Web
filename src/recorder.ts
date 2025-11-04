/**
 * VocaFuse Audio Recorder
 * 
 * Cross-platform MediaRecorder implementation with format detection,
 * duration limits, and browser compatibility handling.
 */

import { VoicenoteError, ErrorCode, wrapUnknownError } from './errors.js';

export interface RecorderConfig {
  maxDuration?: number; // Maximum voicenote duration in seconds (default: 60)
  audioBitsPerSecond?: number; // Audio bitrate (optional)
  onProgress?: (duration: number) => void; // Progress callback
  onDataAvailable?: (chunk: Blob) => void; // Data chunk callback
}

export interface VoicenoteResult {
  blob: Blob;
  mimeType: string;
  duration: number;
  size: number;
  format: string; // 'webm', 'ogg', or 'mp4'
}

export enum RecorderState {
  INACTIVE = 'inactive',
  RECORDING = 'voicenote',
  PAUSED = 'paused'
}

/**
 * Cross-platform audio recorder using MediaRecorder API
 */
export class AudioRecorder {
  private mediaRecorder: MediaRecorder | null = null;
  private mediaStream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private startTime: number = 0;
  private pausedTime: number = 0;
  private progressTimer: number | null = null;
  private readonly config: Required<RecorderConfig>;
  private readonly supportedMimeType: string;

  constructor(config: RecorderConfig = {}) {
    this.config = {
      maxDuration: 60, // 60 seconds default
      audioBitsPerSecond: 128000, // 128kbps default
      onProgress: () => {},
      onDataAvailable: () => {},
      ...config
    };

    // Detect best supported format for this browser
    this.supportedMimeType = this.detectSupportedMimeType();
    
    if (!this.supportedMimeType) {
      throw new VoicenoteError(
        ErrorCode.RECORDING_NOT_SUPPORTED,
        'MediaRecorder is not supported in this browser or no compatible audio formats found'
      );
    }
  }

  /**
   * Get the current voicenote state
   */
  get state(): RecorderState {
    if (!this.mediaRecorder) return RecorderState.INACTIVE;
    return this.mediaRecorder.state as RecorderState;
  }

  /**
   * Get the detected MIME type for this browser
   */
  get mimeType(): string {
    return this.supportedMimeType;
  }

  /**
   * Get current voicenote duration in seconds
   */
  get currentDuration(): number {
    if (this.state === RecorderState.INACTIVE) return 0;
    if (this.state === RecorderState.PAUSED) return this.pausedTime;
    return (Date.now() - this.startTime) / 1000;
  }

  /**
   * Check if MediaRecorder is supported in this browser
   */
  static isSupported(): boolean {
    return typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  }

  /**
   * Request microphone permission and start voicenote
   */
  async start(): Promise<void> {
    try {
      if (this.state !== RecorderState.INACTIVE) {
        throw new VoicenoteError(
          ErrorCode.RECORDING_FAILED,
          `Cannot start voicenote: current state is ${this.state}`
        );
      }

      // Request microphone access
      this.mediaStream = await this.requestMicrophoneAccess();
      
      // Create MediaRecorder with detected format
      this.mediaRecorder = new MediaRecorder(this.mediaStream, {
        mimeType: this.supportedMimeType,
        audioBitsPerSecond: this.config.audioBitsPerSecond
      });

      // Set up event listeners
      this.setupEventListeners();

      // Clear previous voicenote data
      this.chunks = [];
      this.startTime = Date.now();
      this.pausedTime = 0;

      // Start voicenote
      this.mediaRecorder.start(1000); // Collect data every 1 second

      // Start progress timer
      this.startProgressTimer();

    } catch (error) {
      await this.cleanup();
      
      if (error instanceof VoicenoteError) {
        throw error;
      }
      
      // Handle specific browser errors
      if (error instanceof Error) {
        if (error.name === 'NotAllowedError') {
          throw new VoicenoteError(
            ErrorCode.MICROPHONE_ACCESS_DENIED,
            'Microphone access was denied by the user',
            error
          );
        }
        if (error.name === 'NotFoundError') {
          throw new VoicenoteError(
            ErrorCode.RECORDING_NOT_SUPPORTED,
            'No microphone found on this device',
            error
          );
        }
        if (error.name === 'NotSupportedError') {
          throw new VoicenoteError(
            ErrorCode.RECORDING_NOT_SUPPORTED,
            'MediaRecorder is not supported in this browser',
            error
          );
        }
      }
      
      throw wrapUnknownError(error, { operation: 'start voicenote' });
    }
  }

  /**
   * Pause the current voicenote
   */
  pause(): void {
    if (this.state !== RecorderState.RECORDING) {
      throw new VoicenoteError(
        ErrorCode.RECORDING_FAILED,
        `Cannot pause voicenote: current state is ${this.state}`
      );
    }

    this.mediaRecorder!.pause();
    this.pausedTime = (Date.now() - this.startTime) / 1000;
    this.stopProgressTimer();
  }

  /**
   * Resume a paused voicenote
   */
  resume(): void {
    if (this.state !== RecorderState.PAUSED) {
      throw new VoicenoteError(
        ErrorCode.RECORDING_FAILED,
        `Cannot resume voicenote: current state is ${this.state}`
      );
    }

    this.mediaRecorder!.resume();
    this.startTime = Date.now() - (this.pausedTime * 1000);
    this.startProgressTimer();
  }

  /**
   * Stop voicenote and return the result
   */
  async stop(): Promise<VoicenoteResult> {
    return new Promise((resolve, reject) => {
      if (this.state === RecorderState.INACTIVE) {
        reject(new VoicenoteError(
          ErrorCode.RECORDING_FAILED,
          'Cannot stop voicenote: no active voicenote'
        ));
        return;
      }

      // Set up one-time stop handler
      const handleStop = async () => {
        try {
          // Wait a bit for final data to be available
          await new Promise(resolve => setTimeout(resolve, 100));
          
          // Calculate duration BEFORE cleanup (which resets startTime)
          // Use the actual elapsed time since start, not the getter
          const duration = (Date.now() - this.startTime) / 1000;
          
          // Create blob from collected chunks
          const blob = new Blob(this.chunks, { type: this.supportedMimeType });
          const format = this.extractFormatFromMimeType(this.supportedMimeType);

          const result: VoicenoteResult = {
            blob,
            mimeType: this.supportedMimeType,
            duration,
            size: blob.size,
            format
          };

          // Cleanup after creating the result
          await this.cleanup();
          resolve(result);
        } catch (error) {
          await this.cleanup();
          reject(wrapUnknownError(error, { operation: 'stop voicenote' }));
        }
      };

      this.mediaRecorder!.addEventListener('stop', handleStop, { once: true });
      this.mediaRecorder!.stop();
      this.stopProgressTimer();
    });
  }

  /**
   * Cancel voicenote and cleanup without returning data
   */
  async cancel(): Promise<void> {
    if (this.state === RecorderState.INACTIVE) return;
    
    this.mediaRecorder!.stop();
    this.stopProgressTimer();
    await this.cleanup();
  }

  /**
   * Get supported audio formats for this browser
   */
  static getSupportedFormats(): string[] {
    const formats = [
      'audio/webm;codecs=opus',    // Chrome, Edge, Android Chrome
      'audio/ogg;codecs=opus',     // Firefox (all platforms)
      'audio/mp4;codecs=mp4a',     // Safari (all platforms)
      'audio/webm',                // Fallback
      'audio/mp4'                  // Fallback
    ];
    
    return formats.filter(format => MediaRecorder.isTypeSupported(format));
  }

  private detectSupportedMimeType(): string {
    const formats = [
      'audio/webm;codecs=opus',    // Chrome, Edge, Android Chrome
      'audio/ogg;codecs=opus',     // Firefox (all platforms)
      'audio/mp4;codecs=mp4a',     // Safari (all platforms)
      'audio/webm',                // Fallback
      'audio/mp4'                  // Fallback
    ];

    return formats.find(format => MediaRecorder.isTypeSupported(format)) || '';
  }

  private async requestMicrophoneAccess(): Promise<MediaStream> {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1 // Mono audio for voice voicenote
        }
      });
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'NotAllowedError') {
          throw new VoicenoteError(
            ErrorCode.MICROPHONE_ACCESS_DENIED,
            'Microphone access denied. Please allow microphone access and try again.',
            error
          );
        }
      }
      throw error as Error;
    }
  }

  private setupEventListeners(): void {
    if (!this.mediaRecorder) return;

    this.mediaRecorder.addEventListener('dataavailable', (event) => {
      if (event.data && event.data.size > 0) {
        this.chunks.push(event.data);
        this.config.onDataAvailable(event.data);
      }
    });

    this.mediaRecorder.addEventListener('error', (event) => {
      const error = new VoicenoteError(
        ErrorCode.RECORDING_FAILED,
        `MediaRecorder error: ${event.error?.message || 'Unknown error'}`,
        event.error || undefined
      );
      
      this.cleanup().then(() => {
        throw error;
      });
    });
  }

  private startProgressTimer(): void {
    this.stopProgressTimer(); // Clear any existing timer
    
    this.progressTimer = window.setInterval(() => {
      const duration = this.currentDuration;
      
      // Check duration limit
      if (duration >= this.config.maxDuration) {
        this.stop().catch(error => {
          throw new VoicenoteError(
            ErrorCode.RECORDING_TOO_LONG,
            `Voicenote stopped: maximum duration of ${this.config.maxDuration} seconds exceeded`,
            error as Error
          );
        });
        return;
      }
      
      this.config.onProgress(duration);
    }, 100); // Update every 100ms for smooth progress
  }

  private stopProgressTimer(): void {
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
  }

  private async cleanup(): Promise<void> {
    this.stopProgressTimer();
    
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => track.stop());
      this.mediaStream = null;
    }
    
    this.mediaRecorder = null;
    this.chunks = [];
    this.startTime = 0;
    this.pausedTime = 0;
  }

  private extractFormatFromMimeType(mimeType: string): string {
    if (mimeType.includes('webm')) return 'webm';
    if (mimeType.includes('ogg')) return 'ogg';
    if (mimeType.includes('mp4')) return 'mp4';
    return 'unknown';
  }
}


