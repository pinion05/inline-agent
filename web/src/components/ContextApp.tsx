import { createSignal, onMount, onCleanup, For, Show } from 'solid-js';

interface ToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

interface MsgData {
  role: string;
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  tokens: number;
}

interface Stats {
  totalTokens: number;
  messageCount: number;
  contextWindow: number;
  compressionHistory: { from: number; to: number; time: string }[];
  lastAction: string;
}

interface Snapshot {
  stats: Stats;
  messages: MsgData[];
}

const ROLE_COLORS: Record<string, string> = {
  user: '#58a6ff',
  assistant: '#3fb950',
  tool: '#d29922',
};

const ROLE_LABELS: Record<string, string> = {
  user: 'USER',
  assistant: 'ASSISTANT',
  tool: 'TOOL',
  system: 'SYSTEM',
};

export default function ContextApp() {
  const [snapshot, setSnapshot] = createSignal<Snapshot>({
    stats: { totalTokens: 0, messageCount: 0, contextWindow: 0, compressionHistory: [], lastAction: 'connecting...' },
    messages: [],
  });
  let es: EventSource | undefined;

  onMount(() => {
    es = new EventSource('/events');
    es.onmessage = (e) => setSnapshot(JSON.parse(e.data));
    es.onerror = () => {
      const s = snapshot();
      setSnapshot({ ...s, stats: { ...s.stats, lastAction: 'reconnecting...' } });
    };
  });

  onCleanup(() => es?.close());

  const usagePct = () => {
    const s = snapshot().stats;
    return s.contextWindow > 0 ? (s.totalTokens / s.contextWindow * 100) : 0;
  };

  const isCompressed = (m: MsgData) =>
    m.role === 'assistant' && !m.toolCalls?.length && !m.toolCallId && snapshot().stats.compressionHistory.length > 0;

  return (
    <div style={{ padding: '20px', 'max-width': '1200px', margin: '0 auto' }}>
      {/* Stats Bar */}
      <div style={{
        position: 'sticky', top: '0', 'z-index': '100',
        background: '#0d1117', 'padding-bottom': '16px',
        'border-bottom': '1px solid #30363d', 'margin-bottom': '16px',
      }}>
        <div style={{ display: 'flex', gap: '32px', 'flex-wrap': 'wrap' }}>
          <Stat label="Tokens" value={snapshot().stats.totalTokens.toLocaleString()} />
          <Stat label="Messages" value={String(snapshot().stats.messageCount)} />
          <Stat label="Context Window" value={snapshot().stats.contextWindow.toLocaleString()} />
          <Stat
            label="Usage"
            value={`${usagePct().toFixed(1)}%`}
            color={usagePct() > 80 ? '#f85149' : usagePct() > 50 ? '#f0883e' : '#58a6ff'}
          />
        </div>
        {/* Progress bar */}
        <div style={{
          height: '4px', background: '#21262d', 'border-radius': '2px',
          'margin-top': '10px', overflow: 'hidden',
        }}>
          <div style={{
            height: '100%',
            width: `${Math.min(usagePct(), 100)}%`,
            background: usagePct() > 80 ? '#f85149' : usagePct() > 50 ? '#f0883e' : '#3fb950',
            transition: 'width 0.3s, background 0.3s',
          }} />
        </div>
        <div style={{ 'font-size': '11px', color: '#8b949e', 'margin-top': '6px' }}>
          <span style={{ color: '#58a6ff' }}>●</span> {snapshot().stats.lastAction}
        </div>
      </div>

      {/* Compression Log */}
      <Show when={snapshot().stats.compressionHistory.length > 0}>
        <div style={{
          'margin-bottom': '16px', padding: '10px 14px',
          background: '#1c1208', 'border-radius': '8px',
          'border-left': '3px solid #f0883e',
        }}>
          <div style={{ color: '#f0883e', 'font-weight': '600', 'font-size': '12px', 'margin-bottom': '4px' }}>
            ⚡ Trajectory Compression
          </div>
          <For each={snapshot().stats.compressionHistory}>
            {(c) => (
              <div style={{ color: '#f0883e', 'font-size': '11px', opacity: 0.8 }}>
                {c.time}: {c.from} → {c.to} messages
              </div>
            )}
          </For>
        </div>
      </Show>

      {/* Messages */}
      <div>
        <For each={snapshot().messages}>
          {(msg, i) => (
            <MessageCard
              msg={msg}
              index={i()}
              compressed={isCompressed(msg)}
            />
          )}
        </For>
      </div>
    </div>
  );
}

function Stat(props: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '2px' }}>
      <span style={{ color: '#8b949e', 'font-size': '10px', 'text-transform': 'uppercase', 'letter-spacing': '0.5px' }}>
        {props.label}
      </span>
      <span style={{
        color: props.color ?? '#58a6ff',
        'font-size': '20px',
        'font-weight': '600',
      }}>
        {props.value}
      </span>
    </div>
  );
}

function MessageCard(props: { msg: MsgData; index: number; compressed: boolean }) {
  const color = () => ROLE_COLORS[props.msg.role] ?? '#8b949e';
  const label = () => ROLE_LABELS[props.msg.role] ?? props.msg.role.toUpperCase();

  return (
    <div style={{
      'margin-bottom': '8px', padding: '12px 16px',
      'border-radius': '8px',
      'border-left': `3px solid ${props.compressed ? '#f0883e' : color()}`,
      background: props.compressed ? '#1a1510' : '#161b22',
      opacity: props.compressed ? '0.9' : '1',
      animation: 'fadeIn 0.2s ease',
    }}>
      {/* Role header */}
      <div style={{
        display: 'flex', 'align-items': 'center', gap: '8px',
        'margin-bottom': '6px',
      }}>
        <span style={{
          'font-size': '10px', 'text-transform': 'uppercase',
          color: '#8b949e', 'font-weight': '600',
        }}>
          {label()}
        </span>
        <span style={{
          'font-size': '9px', padding: '1px 6px', 'border-radius': '10px',
          background: '#21262d', color: '#8b949e',
        }}>
          ~{props.msg.tokens} tok
        </span>
        <Show when={props.compressed}>
          <span style={{
            'font-size': '9px', padding: '1px 6px', 'border-radius': '10px',
            background: '#3d2b1f', color: '#f0883e',
          }}>
            COMPRESSED
          </span>
        </Show>
        <Show when={props.msg.toolCalls?.length}>
          <span style={{
            'font-size': '9px', padding: '1px 6px', 'border-radius': '10px',
            background: '#1a3a5c', color: '#58a6ff',
          }}>
            +{props.msg.toolCalls!.length} tool_call
          </span>
        </Show>
        <Show when={props.msg.toolCallId}>
          <span style={{
            'font-size': '9px', padding: '1px 6px', 'border-radius': '10px',
            background: '#3d3515', color: '#d29922',
          }}>
            tool result
          </span>
        </Show>
      </div>

      {/* Content */}
      <Show when={props.msg.content}>
        <div style={{
          'white-space': 'pre-wrap', 'word-break': 'break-word',
          'line-height': '1.6', 'font-size': '13px',
          'max-height': '400px', 'overflow-y': 'auto',
        }}>
          {props.msg.content}
        </div>
      </Show>

      {/* Tool calls */}
      <Show when={props.msg.toolCalls?.length}>
        <For each={props.msg.toolCalls}>
          {(tc) => (
            <div style={{
              'margin-top': '8px', padding: '8px 12px',
              background: '#0d1117', 'border-radius': '6px',
              'font-size': '12px', 'border': '1px solid #30363d',
            }}>
              <span style={{ color: '#d29922' }}>$ </span>
              <span style={{ color: '#c9d1d9' }}>
                {(() => {
                  try { return JSON.parse(tc.function.arguments).command ?? '(unknown)'; }
                  catch { return tc.function.arguments; }
                })()}
              </span>
            </div>
          )}
        </For>
      </Show>
    </div>
  );
}
