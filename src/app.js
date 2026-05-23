const invoke = window.__TAURI__?.core?.invoke;
const editor = document.querySelector('#editor');
const lineNumbers = document.querySelector('#lineNumbers');
const status = document.querySelector('#status');
const contextIndicator = document.querySelector('#contextIndicator');
const columnRuler = document.querySelector('#columnRuler');
const chatMessages = document.querySelector('#chatMessages');
const themeMode = document.querySelector('#themeMode');

const toLineCol = () => {
  const pos = editor.selectionStart;
  const before = editor.value.slice(0, pos);
  const line = before.split('\n').length;
  const col = before.length - before.lastIndexOf('\n');
  status.textContent = `Ln ${line}, Col ${col}`;
};

const refreshRulers = () => {
  const lines = editor.value.split('\n').length;
  lineNumbers.textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\n');
  const maxColumns = 120;
  columnRuler.textContent = Array.from({ length: maxColumns }, (_, i) => ((i + 1) % 10 === 0 ? String((i + 1) / 10).slice(-1) : '·')).join('');
  contextIndicator.textContent = `Context: ${editor.value.length} chars`;
};

const appendMessage = (role, text) => {
  const div = document.createElement('div');
  div.textContent = `${role}: ${text}`;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
};

editor.addEventListener('input', () => {
  refreshRulers();
  toLineCol();
});
editor.addEventListener('click', toLineCol);
editor.addEventListener('keyup', toLineCol);

const call = async (cmd, payload = {}) => {
  if (!invoke) throw new Error('Tauri API is unavailable');
  return invoke(cmd, payload);
};

document.querySelector('#newFile').addEventListener('click', async () => {
  editor.value = await call('new_file');
  refreshRulers();
  toLineCol();
});

document.querySelector('#openFile').addEventListener('click', async () => {
  const path = document.querySelector('#filePath').value.trim();
  editor.value = await call('open_file', { req: { path } });
  refreshRulers();
  toLineCol();
});

document.querySelector('#saveFile').addEventListener('click', async () => {
  const path = document.querySelector('#filePath').value.trim();
  await call('save_file', { req: { path, content: editor.value } });
  appendMessage('system', `Saved ${path}`);
});

document.querySelector('#refreshModels').addEventListener('click', async () => {
  const address = document.querySelector('#apiAddress').value.trim();
  const models = await call('fetch_models', { address });
  const container = document.querySelector('#models');
  container.innerHTML = '';
  for (const model of models) {
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.name = 'model';
    box.value = model;
    label.appendChild(box);
    label.append(` ${model}`);
    container.appendChild(label);
  }
});

document.querySelector('#sendPrompt').addEventListener('click', async () => {
  const prompt = document.querySelector('#chatInput').value.trim();
  if (!prompt) return;
  appendMessage('user', prompt);

  const selectedStart = editor.selectionStart;
  const selectedEnd = editor.selectionEnd;
  let selectedText = '';

  if (selectedEnd > selectedStart) {
    selectedText = await call('mcp_tool', {
      command: 'get_selected_text',
      content: editor.value,
      payload: { start: selectedStart, end: selectedEnd },
    });
  }

  appendMessage('context', selectedText || '(no selection)');
  document.querySelector('#chatInput').value = '';
});

themeMode.addEventListener('change', async () => {
  document.documentElement.dataset.theme = themeMode.value;
  await call('save_user_settings', { settings: { theme: themeMode.value } });
});

(async () => {
  document.documentElement.dataset.theme = 'auto';
  try {
    const settings = await call('load_user_settings');
    if (settings?.theme) {
      themeMode.value = settings.theme;
      document.documentElement.dataset.theme = settings.theme;
    }
  } catch {
    // keep defaults
  }

  refreshRulers();
  toLineCol();
})();
