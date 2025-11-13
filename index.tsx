/* tslint:disable */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleGenAI, LiveServerMessage, Modality, Session} from '@google/genai';
import {LitElement, css, html} from 'lit';
import {customElement, state} from 'lit/decorators.js';
import {createBlob, decode, decodeAudioData} from './utils';
import './visual-3d';

@customElement('gdm-live-audio')
export class GdmLiveAudio extends LitElement {
  @state() isRecording = false;
  @state() status = '';
  @state() error = '';
  @state() selectedVoice = 'Orus';

  private client: GoogleGenAI;
  private sessionPromise: Promise<Session>;
  // Fix: Cast window to any to access webkitAudioContext for broader browser support.
  private inputAudioContext = new (window.AudioContext ||
    (window as any).webkitAudioContext)({sampleRate: 16000});
  private outputAudioContext = new (window.AudioContext ||
    (window as any).webkitAudioContext)({sampleRate: 24000});
  @state() inputNode = this.inputAudioContext.createGain();
  @state() outputNode = this.outputAudioContext.createGain();
  private nextStartTime = 0;
  private mediaStream: MediaStream;
  private sourceNode: AudioBufferSourceNode;
  private scriptProcessorNode: ScriptProcessorNode;
  private sources = new Set<AudioBufferSourceNode>();
  private readonly voices = [
    'Orus',
    'Zephyr',
    'Puck',
    'Charon',
    'Kore',
    'Fenrir',
  ];

  static styles = css`
    #status {
      position: absolute;
      bottom: 5vh;
      left: 0;
      right: 0;
      z-index: 10;
      text-align: center;
      color: white;
      font-family: sans-serif;
    }

    .controls {
      z-index: 10;
      position: absolute;
      bottom: 10vh;
      left: 0;
      right: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      gap: 10px;

      button {
        outline: none;
        border: 1px solid rgba(255, 255, 255, 0.2);
        color: white;
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.1);
        width: 64px;
        height: 64px;
        cursor: pointer;
        font-size: 24px;
        padding: 0;
        margin: 0;
        display: flex;
        align-items: center;
        justify-content: center;

        &:hover {
          background: rgba(255, 255, 255, 0.2);
        }
      }

      button[disabled] {
        display: none;
      }
    }

    .button-group {
      display: flex;
      gap: 10px;
    }

    .voice-selector {
      display: flex;
      align-items: center;
      gap: 10px;
      color: white;
      margin-bottom: 10px;
      font-family: sans-serif;
    }

    .voice-selector select {
      outline: none;
      border: 1px solid rgba(255, 255, 255, 0.2);
      color: white;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.1);
      padding: 8px 12px;
      cursor: pointer;
      font-size: 16px;
    }

    .voice-selector select:hover {
      background: rgba(255, 255, 255, 0.2);
    }

    .voice-selector select:disabled {
      cursor: not-allowed;
      opacity: 0.5;
    }

    .voice-selector option {
      background: #100c14;
      color: white;
    }
  `;

  constructor() {
    super();
    this.initClient();
  }

  private initAudio() {
    this.nextStartTime = this.outputAudioContext.currentTime;
  }

  private initClient() {
    this.initAudio();

    this.client = new GoogleGenAI({
      apiKey: process.env.API_KEY,
    });

    this.outputNode.connect(this.outputAudioContext.destination);

    this.initSession();
  }

  private initSession() {
    const model = 'gemini-2.5-flash-native-audio-preview-09-2025';

    this.sessionPromise = this.client.live.connect({
      model: model,
      callbacks: {
        onopen: () => {
          this.updateStatus('Connected');
        },
        onmessage: async (message: LiveServerMessage) => {
          const audio = message.serverContent?.modelTurn?.parts[0]?.inlineData;

          if (audio) {
            this.nextStartTime = Math.max(
              this.nextStartTime,
              this.outputAudioContext.currentTime,
            );

            const audioBuffer = await decodeAudioData(
              decode(audio.data),
              this.outputAudioContext,
              24000,
              1,
            );
            const source = this.outputAudioContext.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(this.outputNode);
            source.addEventListener('ended', () => {
              this.sources.delete(source);
            });

            source.start(this.nextStartTime);
            this.nextStartTime = this.nextStartTime + audioBuffer.duration;
            this.sources.add(source);
          }

          const interrupted = message.serverContent?.interrupted;
          if (interrupted) {
            for (const source of this.sources.values()) {
              source.stop();
              this.sources.delete(source);
            }
            this.nextStartTime = 0;
          }
        },
        onerror: (e: ErrorEvent) => {
          this.updateError(e.message);
        },
        onclose: (e: CloseEvent) => {
          this.updateStatus('Connection closed.');
        },
      },
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {prebuiltVoiceConfig: {voiceName: this.selectedVoice}},
        },
      },
    });

    this.sessionPromise.catch((e) => {
      console.error(e);
      this.updateError(e.message);
    });
  }

  private updateStatus(msg: string) {
    this.status = msg;
    this.error = '';
  }

  private updateError(msg: string) {
    this.error = msg;
  }

  private async startRecording() {
    if (this.isRecording) {
      return;
    }

    this.inputAudioContext.resume();

    this.updateStatus('Requesting microphone access...');

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });

      this.updateStatus('Microphone access granted. Starting capture...');

      this.sourceNode = this.inputAudioContext.createMediaStreamSource(
        this.mediaStream,
      );
      this.sourceNode.connect(this.inputNode);

      const bufferSize = 4096;
      this.scriptProcessorNode = this.inputAudioContext.createScriptProcessor(
        bufferSize,
        1,
        1,
      );

      this.scriptProcessorNode.onaudioprocess = (audioProcessingEvent) => {
        if (!this.isRecording) return;

        const inputBuffer = audioProcessingEvent.inputBuffer;
        const pcmData = inputBuffer.getChannelData(0);

        this.sessionPromise.then((session) => {
          session.sendRealtimeInput({media: createBlob(pcmData)});
        });
      };

      this.sourceNode.connect(this.scriptProcessorNode);
      this.scriptProcessorNode.connect(this.inputAudioContext.destination);

      this.isRecording = true;
      this.updateStatus('🔴 Recording...');
    } catch (err) {
      console.error('Error starting recording:', err);
      this.updateStatus(`Error: ${err.message}`);
      this.stopRecording();
    }
  }

  private stopRecording() {
    if (!this.isRecording && !this.mediaStream && !this.inputAudioContext)
      return;

    this.updateStatus('Stopping recording...');

    this.isRecording = false;

    if (this.scriptProcessorNode && this.sourceNode && this.inputAudioContext) {
      this.scriptProcessorNode.disconnect();
      this.sourceNode.disconnect();
    }

    this.scriptProcessorNode = null;
    this.sourceNode = null;

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    this.updateStatus('Recording stopped.');
  }

  private reset() {
    this.sessionPromise?.then((session) => session.close());
    this.initSession();
    this.updateStatus('Session cleared.');
  }

  private handleVoiceChange(e: Event) {
    const select = e.target as HTMLSelectElement;
    this.selectedVoice = select.value;
    this.reset();
  }

  render() {
    return html`
      <div>
        <div class="controls">
          <div class="voice-selector">
            <label for="voice-select">Voice:</label>
            <select
              id="voice-select"
              @change=${this.handleVoiceChange}
              ?disabled=${this.isRecording}>
              ${this.voices.map(
                (voice) =>
                  html`<option
                    .value=${voice}
                    ?selected=${voice === this.selectedVoice}>
                    ${voice}
                  </option>`,
              )}
            </select>
          </div>
          <div class="button-group">
            <button
              id="resetButton"
              @click=${this.reset}
              ?disabled=${this.isRecording}>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                height="40px"
                viewBox="0 -960 960 960"
                width="40px"
                fill="#ffffff">
                <path
                  d="M480-160q-134 0-227-93t-93-227q0-134 93-227t227-93q69 0 132 28.5T720-690v-110h80v280H520v-80h168q-32-56-87.5-88T480-720q-100 0-170 70t-70 170q0 100 70 170t170 70q77 0 139-44t87-116h84q-28 106-114 173t-196 67Z" />
              </svg>
            </button>
            <button
              id="startButton"
              @click=${this.startRecording}
              ?disabled=${this.isRecording}>
              <svg
                viewBox="0 0 100 100"
                width="32px"
                height="32px"
                fill="#c80000"
                xmlns="http://www.w3.org/2000/svg">
                <circle cx="50" cy="50" r="50" />
              </svg>
            </button>
            <button
              id="stopButton"
              @click=${this.stopRecording}
              ?disabled=${!this.isRecording}>
              <svg
                viewBox="0 0 100 100"
                width="32px"
                height="32px"
                fill="#ffffff"
                xmlns="http://www.w3.org/2000/svg">
                <rect x="15" y="15" width="70" height="70" rx="8" />
              </svg>
            </button>
          </div>
        </div>

        <div id="status">${this.status} ${this.error}</div>
        <gdm-live-audio-visuals-3d
          .inputNode=${this.inputNode}
          .outputNode=${this.outputNode}></gdm-live-audio-visuals-3d>
      </div>
    `;
  }
}