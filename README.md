# VocaFuse Frontend SDK

Production-ready voice input within hours. Framework-friendly primitives: create and control a recorder; you own the UI.

## Install

```bash
npm install @vocafuse/frontend-sdk
```

## Quick Start (Vanilla)

```ts
import { VocaFuseSDK } from '@vocafuse/frontend-sdk'

// Initialize
const sdk = new VocaFuseSDK({
  tokenEndpoint: '/api/token',            // your backend endpoint that returns VocaFuse tokens
  apiBaseUrl: 'https://api.vocafuse.com'  // optional; defaults to https://api.vocafuse.com
})
await sdk.init()

// Create a recorder
const recorder = sdk.createRecorder({
  maxDuration: 60,
  onStateChange: (state) => console.log('state:', state),
  onRecordProgress: (s) => console.log('seconds:', s),
  onUploadProgress: (p) => console.log('upload %:', p),
  onComplete: (result) => console.log('uploaded:', result.voicenote_id),
  onError: (err) => console.error(err)
})

// Wire up any UI
const btn = document.getElementById('record-btn')!
btn.addEventListener('click', async () => {
  if (recorder.isRecording) {
    await recorder.stop() // auto-uploads
  } else {
    await recorder.start()
  }
})
```

## React Example

```tsx
import { useEffect, useState } from 'react'
import { VocaFuseSDK } from '@vocafuse/frontend-sdk'

export default function VoiceNote() {
  const [recorder, setRecorder] = useState<any>(null)

  useEffect(() => {
    (async () => {
      const sdk = new VocaFuseSDK({ tokenEndpoint: '/api/token' })
      await sdk.init()
      setRecorder(sdk.createRecorder({ onStateChange: () => setRecorder(r => ({ ...r })) }))
    })()
  }, [])

  if (!recorder) return <button disabled>Loading…</button>

  return (
    <button onClick={() => recorder.isRecording ? recorder.stop() : recorder.start()}>
      {recorder.isRecording ? 'Stop Recording' : 'Start Recording'}
    </button>
  )
}
```

## API

- new VocaFuseSDK(config)
  - tokenEndpoint (string, required)
  - apiBaseUrl (string, default: https://api.vocafuse.com)
- await sdk.init()
- sdk.createRecorder(options) -> VoiceRecorder
- sdk.getInfo() -> { version, voicenoteSupported, tokenEndpoint, apiBaseUrl, identity }

### VoiceRecorder
- Properties: state, duration, isRecording, isUploading
- Methods: start(), stop(), cancel(), pause(), resume(), destroy()
- Options: maxDuration?, autoUpload? (default true)
- Callbacks: onStateChange, onRecordProgress, onUploadProgress, onComplete, onError, onCancel

## Notes
- Keep your tokenEndpoint on your backend. Do not expose credentials in the browser.
