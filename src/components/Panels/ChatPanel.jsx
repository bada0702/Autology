import React, { useState, useRef, useEffect, useContext, useCallback } from 'react';
import { Send, X, MessageSquare, Bot, User, Trash2, Sparkles, RefreshCw, StopCircle } from 'lucide-react';
import { useKGRAG } from '../../hooks/useKGRAG';
import GraphContext from '../../context/GraphContext';
import LLMContext from '../../context/LLMContext';
import './ChatPanel.css';

export default function ChatPanel({ onClose }) {
  const [query, setQuery] = useState('');
  const [messages, setMessages] = useState([
    { role: 'assistant', content: '안녕하세요! 생성된 지식 그래프에 대해 무엇이든 물어보세요. 쿼리에 노드 이름이 포함되면 관련 서브그래프만 추출해서 양방향으로 탐색합니다.' }
  ]);
  const [currentAssistantMessage, setCurrentAssistantMessage] = useState('');
  const { askKG, cancel, isGenerating } = useKGRAG();
  const cancelledRef = useRef(false);
  const { state: graphState } = useContext(GraphContext);
  const { state: llmState } = useContext(LLMContext);

  // Drag state
  const panelRef   = useRef(null);
  const dragRef    = useRef({ dragging: false, startX: 0, startY: 0, origLeft: 0, origTop: 0 });
  const [pos, setPos] = useState(null); // null = use CSS default (bottom-right)

  const onHeaderMouseDown = useCallback((e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    dragRef.current = {
      dragging: true,
      startX: e.clientX,
      startY: e.clientY,
      origLeft: rect.left,
      origTop: rect.top,
    };
  }, []);

  useEffect(() => {
    const onMouseMove = (e) => {
      const d = dragRef.current;
      if (!d.dragging) return;
      const panel = panelRef.current;
      if (!panel) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      const newLeft = Math.max(0, Math.min(window.innerWidth  - panel.offsetWidth,  d.origLeft + dx));
      const newTop  = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, d.origTop  + dy));
      setPos({ left: newLeft, top: newTop });
    };
    const onMouseUp = () => { dragRef.current.dragging = false; };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, currentAssistantMessage]);

  const handleSend = async () => {
    if (!query.trim() || isGenerating) return;

    const userQuery = query.trim();
    setQuery('');
    cancelledRef.current = false;

    const newMessages = [...messages, { role: 'user', content: userQuery }];
    setMessages(newMessages);
    setCurrentAssistantMessage('');

    const history = messages.slice(-5).map(m => ({ role: m.role, content: m.content }));

    const result = await askKG(userQuery, history, (chunk) => {
      setCurrentAssistantMessage(prev => prev + chunk);
    });

    setCurrentAssistantMessage('');
    if (result) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: result.content,
        meta: result.meta,
      }]);
    } else if (!cancelledRef.current) {
      setMessages(prev => [...prev, { role: 'assistant', content: '죄송합니다. 답변을 생성하는 중에 오류가 발생했습니다.' }]);
    }
  };

  const handleCancel = () => {
    cancelledRef.current = true;
    cancel();
    setCurrentAssistantMessage('');
  };

  const clearChat = () => {
    setMessages([{ role: 'assistant', content: '채팅 내역이 초기화되었습니다. 무엇을 도와드릴까요?' }]);
  };

  const panelStyle = pos
    ? { left: pos.left, top: pos.top, right: 'auto', bottom: 'auto' }
    : undefined;

  return (
    <div className="chat-panel glass" ref={panelRef} style={panelStyle}>
      <div className="chat-header chat-header--draggable" onMouseDown={onHeaderMouseDown}>
        <div className="chat-title">
          <MessageSquare size={16} />
          <span>지식 그래프 AI 테스트</span>
        </div>
        <div className="chat-header-actions">
          <button className="chat-icon-btn" onClick={clearChat} title="대화 초기화">
            <Trash2 size={14} />
          </button>
          <button className="chat-icon-btn" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
      </div>

      <div className="chat-stats">
        <div className="chat-stat-item">
          <span className="stat-label">노드</span>
          <span className="stat-value">{graphState.nodes.length}</span>
        </div>
        <div className="chat-stat-item">
          <span className="stat-label">엣지</span>
          <span className="stat-value">{graphState.edges.length}</span>
        </div>
        <span className="chat-model-name">{llmState.model}</span>
        <div className="chat-rag-badge">
          <Sparkles size={10} />
          <span>RAG Active</span>
        </div>
      </div>

      <div className="chat-messages" ref={scrollRef}>
        {messages.map((m, i) => (
          <div key={i} className={`chat-message chat-message--${m.role}`}>
            <div className="message-icon">
              {m.role === 'assistant' ? <Bot size={14} /> : <User size={14} />}
            </div>
            <div className="message-bubble">
              {m.role === 'assistant' && m.meta && (
                <div className="message-rag-meta">
                  <Sparkles size={9} />
                  <span>{m.meta.mode}</span>
                  {m.meta.anchorLabels?.length > 0 && (
                    <span className="message-rag-anchors">
                      {m.meta.anchorLabels.map(l => (
                        <span key={l} className="message-rag-anchor">★{l}</span>
                      ))}
                    </span>
                  )}
                </div>
              )}
              {m.content}
            </div>
          </div>
        ))}
        {currentAssistantMessage && (
          <div className="chat-message chat-message--assistant">
            <div className="message-icon">
              <Bot size={14} />
            </div>
            <div className="message-bubble">
              {currentAssistantMessage}
              <span className="typing-cursor" />
            </div>
          </div>
        )}
        {isGenerating && !currentAssistantMessage && (
          <div className="chat-message chat-message--assistant">
            <div className="message-icon">
              <Bot size={14} />
            </div>
            <div className="message-bubble loading">
              <RefreshCw size={14} className="spin" />
              <span>그래프 분석 중...</span>
            </div>
          </div>
        )}
      </div>

      <div className="chat-input-area">
        <div className="chat-input-wrapper">
          <textarea
            className="chat-input"
            placeholder="그래프에 대해 질문해보세요..."
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
          />
          {isGenerating ? (
            <button className="chat-send-btn chat-cancel-btn" onClick={handleCancel} title="생성 취소">
              <StopCircle size={16} />
            </button>
          ) : (
            <button
              className={`chat-send-btn ${query.trim() ? 'active' : ''}`}
              onClick={handleSend}
              disabled={!query.trim()}
            >
              <Send size={16} />
            </button>
          )}
        </div>
        <p className="chat-hint">Shift + Enter로 줄바꿈</p>
      </div>
    </div>
  );
}
