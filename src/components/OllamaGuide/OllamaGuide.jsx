import React, { useContext, useEffect, useState, useCallback, useRef } from 'react';
import { Download, RefreshCw, Terminal, Check, Copy, X } from 'lucide-react';
import LLMContext from '../../context/LLMContext';
import './OllamaGuide.css';

const STATUS_URL = '/api/ollama/status';
const DOWNLOAD_URL = 'https://ollama.com/download';

function CommandLine({ cmd }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard 미지원 무시 */ }
  };
  return (
    <div className="ollama-guide__cmd">
      <Terminal size={14} className="ollama-guide__cmd-icon" />
      <code>{cmd}</code>
      <button className="ollama-guide__cmd-copy" onClick={copy} title="복사">
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </div>
  );
}

export default function OllamaGuide() {
  const { state, checkConnection } = useContext(LLMContext);
  const { ollamaUrl, ollamaOnline } = state;

  const [status, setStatus] = useState(null);   // { installed, running, models }
  const [checking, setChecking] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const statusRef = useRef(status);
  statusRef.current = status;

  const fetchStatus = useCallback(async () => {
    try {
      const r = await fetch(STATUS_URL, {
        headers: { 'X-Ollama-Target': ollamaUrl },
        signal: AbortSignal.timeout(5000),
      });
      if (r.ok) setStatus(await r.json());
    } catch { /* 직전 상태 유지 */ }
  }, [ollamaUrl]);

  // 준비될 때까지 주기적으로 상태 확인 (정상이면 폴링 중단)
  useEffect(() => {
    fetchStatus();
    const id = setInterval(() => {
      const s = statusRef.current;
      const ready = s && s.running && (s.models?.length ?? 0) > 0;
      if (!ready) fetchStatus();
    }, 5000);
    return () => clearInterval(id);
  }, [fetchStatus]);

  const recheck = async () => {
    setChecking(true);
    setDismissed(false);
    await Promise.all([fetchStatus(), checkConnection(ollamaUrl)]);
    setChecking(false);
  };

  // 표시 여부 판단
  const noModels = !!status?.running && (status.models?.length ?? 0) === 0;
  const blocked = !!status && (!status.running || noModels);
  if (!blocked || dismissed) return null;

  let scenario;
  if (!status.installed) scenario = 'not-installed';
  else if (!status.running) scenario = 'not-running';
  else scenario = 'no-models';

  return (
    <div className="ollama-guide">
      <div className="ollama-guide__card">
        <button
          className="ollama-guide__close"
          onClick={() => setDismissed(true)}
          title="닫기 (Ollama 없이 둘러보기)"
        >
          <X size={18} />
        </button>

        {scenario === 'not-installed' && (
          <>
            <div className="ollama-guide__badge ollama-guide__badge--danger">Ollama 미설치</div>
            <h2 className="ollama-guide__title">Ollama가 필요합니다</h2>
            <p className="ollama-guide__desc">
              Autology는 로컬에서 동작하는 <strong>Ollama</strong> LLM 서버로 온톨로지를 생성합니다.
              아직 설치돼 있지 않은 것 같습니다. 아래 순서대로 설정해 주세요.
            </p>
            <ol className="ollama-guide__steps">
              <li>
                <span>Ollama를 설치합니다.</span>
                <a className="ollama-guide__dl" href={DOWNLOAD_URL} target="_blank" rel="noreferrer">
                  <Download size={15} /> ollama.com/download
                </a>
              </li>
              <li>
                <span>모델을 하나 받습니다 (터미널/명령 프롬프트).</span>
                <CommandLine cmd="ollama pull gemma2" />
              </li>
              <li>
                <span>이 앱(<code>autology-backend.exe</code>)을 다시 실행하면 Ollama가 자동으로 함께 켜집니다.</span>
              </li>
            </ol>
          </>
        )}

        {scenario === 'not-running' && (
          <>
            <div className="ollama-guide__badge ollama-guide__badge--warning">Ollama 시작 중</div>
            <h2 className="ollama-guide__title">
              <RefreshCw size={20} className="ollama-guide__spin" /> Ollama 서버를 켜는 중입니다…
            </h2>
            <p className="ollama-guide__desc">
              Ollama는 설치돼 있으나 아직 응답하지 않습니다. 보통 몇 초 안에 자동으로 연결됩니다.
              계속 연결되지 않으면 터미널에서 직접 실행해 보세요.
            </p>
            <CommandLine cmd="ollama serve" />
          </>
        )}

        {scenario === 'no-models' && (
          <>
            <div className="ollama-guide__badge ollama-guide__badge--warning">모델 없음</div>
            <h2 className="ollama-guide__title">설치된 모델이 없습니다</h2>
            <p className="ollama-guide__desc">
              Ollama 서버는 실행 중이지만 사용할 수 있는 모델이 없습니다.
              아래 명령으로 모델을 하나 내려받은 뒤 <strong>다시 확인</strong>을 눌러주세요.
            </p>
            <CommandLine cmd="ollama pull gemma2" />
          </>
        )}

        <div className="ollama-guide__footer">
          <span className="ollama-guide__url">대상: {ollamaUrl}</span>
          <button className="ollama-guide__recheck" onClick={recheck} disabled={checking}>
            <RefreshCw size={15} className={checking ? 'ollama-guide__spin' : ''} />
            {checking ? '확인 중…' : '다시 확인'}
          </button>
        </div>
      </div>
    </div>
  );
}
