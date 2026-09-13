<template>
  <el-dialog
    append-to-body
    :model-value="visible"
    :title="editorTitle"
    width="80%"
    :close-on-click-modal="false"
    destroy-on-close
    @update:model-value="(v: boolean) => emit('update:visible', v)"
    @closed="onClosed"
  >
    <div class="editor-host">
      <SyntaxEditor
        ref="editorRef"
        v-model="editorContent"
        :file-path="editorPath"
        :lang="syntaxLang"
        :wrap="editorWrapEnabled"
        :compact="true"
      />
    </div>
    <template #footer>
      <div class="editor-footer">
        <div class="editor-opts">
          <el-select v-model="syntaxLang" style="width: 6.875rem" filterable>
            <el-option v-for="l in LANG_OPTIONS" :key="l.value" :label="l.label" :value="l.value" />
          </el-select>
          <el-select v-model="editorEncoding" style="width: 6.25rem">
            <el-option label="UTF-8" value="utf-8" />
            <el-option label="UTF-16 LE" value="utf-16le" />
            <el-option label="UTF-16 BE" value="utf-16be" />
            <el-option label="GBK" value="gbk" />
          </el-select>
          <el-select v-model="editorLineEnding" style="width: 8.75rem">
            <el-option label="LF (Linux/macOS)" value="lf" />
            <el-option label="CRLF (Windows)" value="crlf" />
            <el-option label="CR (old Mac)" value="cr" />
          </el-select>
          <el-checkbox v-model="editorWrapEnabled" :disabled="wrapDisabled">
            {{ t('sftp.edit.wrap') }}
          </el-checkbox>
        </div>
        <div class="editor-buttons">
          <el-button size="small" @click="onExternal">{{ t('sftp.editExternal') }}</el-button>
          <el-button @click="close">{{ t('sftp.dialog.cancel') }}</el-button>
          <el-button :loading="saving" @click="onSave(false)">{{ t('sftp.edit.save') }}</el-button>
          <el-button type="primary" :loading="saving" @click="onSave(true)">{{ t('sftp.edit.saveClose') }}</el-button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue'
import { useI18n } from '../i18n'
import { msg } from '../services/message'
import { useLocalStateStore } from '../stores/localStateStore'
import {
  SftpGetContent, SftpLocalGetContent, SftpPutContent, SftpLocalPutContent,
  SftpOpenExternalEditor, OpenExternalEditorLocal,
} from '../../bindings/github.com/ys-ll/uniterm/app'
import SyntaxEditor from './SyntaxEditor.vue'

const { t } = useI18n()
const localStateStore = useLocalStateStore()

const props = defineProps<{
  visible?: boolean
  sessionId?: string
  mode?: 'remote' | 'local'
}>()

const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
  (e: 'saved'): void
}>()

const editorRef = ref<{ focus: () => void } | null>(null)
const editorTitle = ref('')
const editorPath = ref('')
const editorContent = ref('')
const editorRawBytes = ref<Uint8Array | null>(null)
const editorEncoding = ref<Encoding>('utf-8')
const editorLineEnding = ref<LineEnding>('lf')
const editorWrapEnabled = ref(true)
const saving = ref(false)

const wrapDisabled = computed(() => /\.(?:pem|key|crt|p7b)$/i.test(editorPath.value))

// Syntax-highlighting language override. Defaults to the language the current
// file's extension maps to (Plain Text when nothing matches), and the rest are
// sorted alphabetically so the dropdown stays scannable.
const syntaxLang = ref('text')

// Map a file path to the language id its extension would highlight as, so the
// dropdown reflects the active mode. Mirrors SyntaxEditor's extension picks.
function langFromPath(path: string): string {
  const base = path.replace(/\\/g, '/').split('/').pop() || ''
  const lower = base.toLowerCase()
  if (lower === 'dockerfile' || lower.startsWith('dockerfile.')) return 'dockerfile'
  if (lower === 'makefile' || lower === 'gnumakefile') return 'conf'
  if (lower === '.bashrc' || lower === '.zshrc' || lower === '.profile' || lower === '.bash_profile') return 'sh'
  if (lower === '.gitignore' || lower === '.dockerignore' || lower === '.env' || lower.endsWith('.env')) return 'conf'
  if (lower === 'nginx.conf' || lower.endsWith('.nginx')) return 'nginx'
  const i = lower.lastIndexOf('.')
  const ext = i >= 0 ? lower.slice(i + 1) : ''
  const map: Record<string, string> = {
    json: 'json', jsonc: 'json', js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'ts', tsx: 'ts',
    html: 'html', htm: 'html', vue: 'html', css: 'css', scss: 'css', less: 'css',
    xml: 'xml', svg: 'xml', md: 'md', markdown: 'md', py: 'py', sql: 'sql',
    yml: 'yaml', yaml: 'yaml', sh: 'sh', bash: 'sh', zsh: 'sh', ksh: 'sh', fish: 'sh',
    conf: 'conf', cfg: 'conf', ini: 'conf', properties: 'conf', toml: 'toml',
    c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', cs: 'csharp',
    dart: 'dart', java: 'java', kt: 'kotlin', scala: 'scala',
    go: 'go', rs: 'rust', rb: 'ruby',
  }
  return map[ext] || 'text'
}
const LANG_OPTIONS = [
  { value: 'c', label: 'C' },
  { value: 'cpp', label: 'C++' },
  { value: 'csharp', label: 'C#' },
  { value: 'css', label: 'CSS' },
  { value: 'dart', label: 'Dart' },
  { value: 'dockerfile', label: 'Dockerfile' },
  { value: 'go', label: 'Go' },
  { value: 'html', label: 'HTML' },
  { value: 'java', label: 'Java' },
  { value: 'js', label: 'JavaScript' },
  { value: 'json', label: 'JSON' },
  { value: 'kotlin', label: 'Kotlin' },
  { value: 'md', label: 'Markdown' },
  { value: 'nginx', label: 'Nginx' },
  { value: 'text', label: 'Plain Text' },
  { value: 'conf', label: 'Properties/INI' },
  { value: 'py', label: 'Python' },
  { value: 'ruby', label: 'Ruby' },
  { value: 'rust', label: 'Rust' },
  { value: 'scala', label: 'Scala' },
  { value: 'sh', label: 'Shell' },
  { value: 'sql', label: 'SQL' },
  { value: 'toml', label: 'TOML' },
  { value: 'ts', label: 'TypeScript' },
  { value: 'xml', label: 'XML' },
  { value: 'yaml', label: 'YAML' },
].sort((a, b) => a.label.localeCompare(b.label))

type Encoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'gbk'
type LineEnding = 'lf' | 'crlf' | 'cr'

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function toBase64(str: string): string {
  return btoa(str)
}

function detectEncoding(bytes: Uint8Array): { encoding: Encoding, hasBom: boolean } {
  if (bytes.length >= 2) {
    if (bytes[0] === 0xFF && bytes[1] === 0xFE) return { encoding: 'utf-16le', hasBom: true }
    if (bytes[0] === 0xFE && bytes[1] === 0xFF) return { encoding: 'utf-16be', hasBom: true }
  }
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    return { encoding: 'utf-8', hasBom: true }
  }
  let nullCount = 0
  const checkLen = Math.min(bytes.length, 1024)
  for (let i = 0; i < checkLen; i++) { if (bytes[i] === 0) nullCount++ }
  if (nullCount > checkLen * 0.3) return { encoding: 'utf-16le', hasBom: false }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return { encoding: 'utf-8', hasBom: false }
  } catch {
    return { encoding: 'gbk', hasBom: false }
  }
}

function detectLineEnding(text: string): LineEnding {
  let crlf = 0, lf = 0, cr = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\r' && text[i + 1] === '\n') { crlf++; i++ }
    else if (text[i] === '\n') lf++
    else if (text[i] === '\r') cr++
  }
  if (crlf > lf && crlf > cr) return 'crlf'
  if (cr > lf && cr > crlf) return 'cr'
  return 'lf'
}

function decodeContent(bytes: Uint8Array, enc: Encoding): string {
  if (enc === 'gbk') {
    try { return new TextDecoder('gbk').decode(bytes) }
    catch { return new TextDecoder('utf-8').decode(bytes) }
  }
  return new TextDecoder(enc === 'utf-16le' ? 'utf-16le' : enc === 'utf-16be' ? 'utf-16be' : 'utf-8').decode(bytes)
}

function encodeContent(text: string, enc: Encoding, lineEnding: LineEnding): string {
  let normalized = text
  if (lineEnding === 'crlf') normalized = text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')
  else if (lineEnding === 'cr') normalized = text.replace(/\r\n/g, '\n').replace(/\n/g, '\r')
  else normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

  if (enc === 'utf-8' || enc === 'gbk') {
    // Always encode as UTF-8; the backend re-encodes to GBK when needed.
    return toBase64(normalized)
  }
  const buf = new Uint8Array(normalized.length * 2 + 2)
  let pos = 0
  buf[pos++] = enc === 'utf-16le' ? 0xFF : 0xFE
  buf[pos++] = enc === 'utf-16le' ? 0xFE : 0xFF
  for (let i = 0; i < normalized.length; i++) {
    const code = normalized.charCodeAt(i)
    buf[pos++] = enc === 'utf-16le' ? (code & 0xFF) : ((code >> 8) & 0xFF)
    buf[pos++] = enc === 'utf-16le' ? ((code >> 8) & 0xFF) : (code & 0xFF)
  }
  let binary = ''
  for (let i = 0; i < pos; i++) binary += String.fromCharCode(buf[i])
  return btoa(binary)
}

function isBinaryContent(bytes: Uint8Array): boolean {
  const sample = bytes.slice(0, 8192)
  if (!sample.length) return false
  let nonPrintable = 0
  for (let i = 0; i < sample.length; i++) {
    const c = sample[i]
    if (c < 0x09 || (c > 0x0D && c < 0x20)) nonPrintable++
  }
  return nonPrintable > sample.length * 0.3
}

// The active local/remote mode for the file being edited. Passed per open() rather
// than read from the `mode` prop, which updates reactively AFTER the parent calls
// open() — reading props.mode here would race and use the previous pane's mode.
const activeMode = ref<'remote' | 'local'>(props.mode || 'remote')

const isLocal = computed(() => activeMode.value === 'local')

async function open(path: string, title: string, mode?: 'remote' | 'local') {
  activeMode.value = mode ?? props.mode ?? 'remote'
  editorPath.value = path
  editorTitle.value = title
  editorContent.value = ''
  editorRawBytes.value = null
  syntaxLang.value = langFromPath(path)
  editorVisibleInternal = true
  emit('update:visible', true)
  const sid = props.sessionId
  if (!sid) return
  try {
    const rawB64 = isLocal.value
      ? await SftpLocalGetContent(sid, path)
      : await SftpGetContent(sid, path)
    const bytes = fromBase64(rawB64)
    if (isBinaryContent(bytes)) {
      close()
      msg.warning(t('sftp.edit.binaryFile'))
      return
    }
    const detected = detectEncoding(bytes)
    editorEncoding.value = detected.encoding
    editorRawBytes.value = bytes
    const text = decodeContent(bytes, detected.encoding)
    editorLineEnding.value = detectLineEnding(text)
    editorContent.value = text
    await nextTick()
    editorRef.value?.focus()
  } catch (e: any) {
    close()
    msg.error(e?.toString?.() || 'Failed to read file')
  }
}

let editorVisibleInternal = false

watch(() => props.visible, (v) => { editorVisibleInternal = v })

watch(editorEncoding, (newEnc) => {
  if (editorVisibleInternal && editorRawBytes.value) {
    editorContent.value = decodeContent(editorRawBytes.value, newEnc)
  }
})

// Switch to the configured external editor: close this dialog and open the same
// file there (remote → download/auto-upload flow, local → open in place).
async function onExternal() {
  const path = editorPath.value
  if (!path) return
  const cmd = localStateStore.state.externalEditor?.trim()
  if (!cmd) {
    msg.warning(t('sftp.editExternalNotConfigured'))
    return
  }
  close()
  try {
    if (isLocal.value) {
      await OpenExternalEditorLocal(path, cmd)
    } else {
      if (!props.sessionId) return
      await SftpOpenExternalEditor(props.sessionId, path, cmd)
    }
    msg.info(t('sftp.editExternalStart', { path }))
  } catch (e: any) {
    msg.error(e?.toString?.() || 'Failed to open external editor')
  }
}

async function onSave(closeAfter: boolean) {
  const sid = props.sessionId
  if (!sid || !editorPath.value) return
  saving.value = true
  try {
    const contentBase64 = encodeContent(editorContent.value, editorEncoding.value, editorLineEnding.value)
    if (isLocal.value) {
      await SftpLocalPutContent(sid, editorPath.value, contentBase64, editorEncoding.value)
    } else {
      await SftpPutContent(sid, editorPath.value, contentBase64, editorEncoding.value)
    }
    emit('saved')
    if (closeAfter) close()
  } catch (e: any) {
    msg.error(e?.toString?.() || 'Failed to save file')
  } finally {
    saving.value = false
  }
}

function close() {
  if (!editorVisibleInternal && !props.visible) return
  emit('update:visible', false)
}

function onClosed() {
  editorPath.value = ''
  editorContent.value = ''
  editorRawBytes.value = null
  editorVisibleInternal = false
}

defineExpose({ open })
</script>

<style scoped>
.editor-host {
  height: 60vh;
  border: 1px solid var(--border-subtle);
  border-radius: 0.25rem;
  overflow: hidden;
  background: #282c34;
}
.editor-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  width: 100%;
}
.editor-buttons {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
/* el-button adds a default 0.75rem left margin between siblings; drop it so the
   buttons sit at the flex gap instead of 0.5rem+0.75rem. */
.editor-buttons .el-button + .el-button {
  margin-left: 0;
}
.editor-opts {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
</style>