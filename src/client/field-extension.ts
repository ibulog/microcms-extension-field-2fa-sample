import { setupFieldExtension, type UpdateStyleMessage } from 'microcms-field-extension-api';
import { readInitialMessage, type InitialData } from '../shared/protocol.js';
import { isRecord } from '../shared/types.js';

export function connectFieldExtension(origin: string, onInitialData: (data: InitialData) => void): () => void {
  // SDK 1.1.0 checks origin/isTrusted, but sends an initial style message before
  // calling onDefaultData. Validate source and payload BEFORE that SDK listener.
  const guard = (event: MessageEvent<unknown>) => {
    if (isRecord(event.data) && event.data.action === 'MICROCMS_GET_DEFAULT_DATA' &&
        !readInitialMessage(event, window.parent, origin)) event.stopImmediatePropagation();
  };
  window.addEventListener('message', guard, { capture: true });
  const cleanup = setupFieldExtension({
    origin,
    height: Math.ceil(document.body.getBoundingClientRect().height),
    width: '100%',
    onDefaultData: event => {
      const data = readInitialMessage(event, window.parent, origin);
      if (data) onInitialData(data);
    },
    // The SDK's default callbacks log payloads; this display-only field does not.
    onPostSuccess: () => {},
    onPostError: () => {},
  });
  return () => {
    cleanup();
    window.removeEventListener('message', guard, { capture: true });
  };
}

export function updateFieldHeight(id: string, origin: string): void {
  // The SDK initializes size; dynamic resize has a public type but no send helper.
  const message: UpdateStyleMessage = { id, action: 'MICROCMS_UPDATE_STYLE',
    message: { height: Math.ceil(document.body.getBoundingClientRect().height), width: '100%' } };
  window.parent.postMessage(message, origin);
}
