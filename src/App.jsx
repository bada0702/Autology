import React from 'react';
import { GraphProvider } from './context/GraphContext';
import { LLMProvider } from './context/LLMContext';
import { WorkflowProvider } from './context/WorkflowContext';
import { RuleProvider } from './context/RuleContext';
import Canvas from './components/Canvas/Canvas';
import Toolbar from './components/Toolbar/Toolbar';
import PropertyPanel from './components/Panels/PropertyPanel';
import WorkflowPanel from './components/Panels/WorkflowPanel';
import RulePanel from './components/Panels/RulePanel';
import MiniMap from './components/MiniMap/MiniMap';
import ChatPanel from './components/Panels/ChatPanel';
import CodeEditorPanel from './components/CodeEditor/CodeEditorPanel';
import './App.css';

const CENTER_TABS = [
  { id: 'canvas', label: '캔버스' },
  { id: 'xml',    label: 'XML Editor' },
  { id: 'ttl',    label: 'TTL Editor' },
];

export default function App() {
  const [showChat, setShowChat] = React.useState(false);
  const [leftTab, setLeftTab]   = React.useState('workflow');
  const [centerTab, setCenterTab] = React.useState('canvas');

  return (
    <GraphProvider>
      <LLMProvider>
        <WorkflowProvider>
          <RuleProvider>
            <div className="app-shell">
              <Toolbar onOpenChat={() => setShowChat(true)} />
              <div className="app-body">
                <div className="left-panel">
                  <div className="left-tabs">
                    <button
                      className={`left-tab${leftTab === 'workflow' ? ' left-tab--active' : ''}`}
                      onClick={() => setLeftTab('workflow')}
                    >워크플로우</button>
                    <button
                      className={`left-tab${leftTab === 'rules' ? ' left-tab--active' : ''}`}
                      onClick={() => setLeftTab('rules')}
                    >규칙 엔진</button>
                  </div>
                  {leftTab === 'workflow'
                    ? <WorkflowPanel onOpenChat={() => setShowChat(true)} />
                    : <RulePanel />}
                </div>

                <div className="canvas-area">
                  <div className="center-tabs">
                    {CENTER_TABS.map(t => (
                      <button
                        key={t.id}
                        className={`center-tab${centerTab === t.id ? ' center-tab--active' : ''}`}
                        onClick={() => setCenterTab(t.id)}
                      >{t.label}</button>
                    ))}
                  </div>

                  <div className="center-content">
                    {/* Canvas는 항상 마운트 유지 — hidden으로만 숨겨서 상태 보존 */}
                    <div className={`center-canvas-wrap${centerTab === 'canvas' ? '' : ' center-canvas-wrap--hidden'}`}>
                      <Canvas />
                      <MiniMap />
                    </div>
                    {centerTab === 'xml' && <CodeEditorPanel format="xml" />}
                    {centerTab === 'ttl' && <CodeEditorPanel format="ttl" />}
                  </div>
                </div>

                <PropertyPanel />
              </div>
              {showChat && <ChatPanel onClose={() => setShowChat(false)} />}
            </div>
          </RuleProvider>
        </WorkflowProvider>
      </LLMProvider>
    </GraphProvider>
  );
}
