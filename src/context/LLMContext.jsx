import React, { createContext, useReducer, useEffect, useRef, useCallback } from 'react';

const LLMContext = createContext();

const STORAGE_KEY = 'autology_ollama_url';

const initialState = {
  model: 'gemma4:e2b',
  ollamaUrl: localStorage.getItem(STORAGE_KEY) || 'http://localhost:11434',
  availableModels: [],
  ollamaOnline: false,
  isGenerating: false,
  streamedContent: '',
  error: null,
};

function llmReducer(state, action) {
  switch (action.type) {
    case 'SET_MODEL':
      return { ...state, model: action.payload };
    case 'SET_MODELS':
      return { ...state, availableModels: action.payload };
    case 'SET_ONLINE':
      return { ...state, ollamaOnline: action.payload };
    case 'SET_OLLAMA_URL': {
      const url = action.payload.replace(/\/$/, '');
      localStorage.setItem(STORAGE_KEY, url);
      return { ...state, ollamaUrl: url, ollamaOnline: false, availableModels: [] };
    }
    case 'START_GENERATION':
      return { ...state, isGenerating: true, error: null, streamedContent: '' };
    case 'UPDATE_STREAM':
      return { ...state, streamedContent: state.streamedContent + action.payload };
    case 'FINISH_GENERATION':
      return { ...state, isGenerating: false };
    case 'SET_ERROR':
      return { ...state, isGenerating: false, error: action.payload };
    case 'CLEAR_STREAM':
      return { ...state, streamedContent: '' };
    default:
      return state;
  }
}

// 개발 모드: Vite 미들웨어(/ollama-proxy). 프로덕션(exe): 백엔드 프록시(/ollama).
// 두 경로 모두 X-Ollama-Target 헤더로 실제 Ollama 주소를 전달한다.
const OLLAMA_PREFIX = import.meta.env.DEV ? '/ollama-proxy' : '/ollama';

export function makeOllamaFetch(ollamaUrl, path, options = {}) {
  return fetch(`${OLLAMA_PREFIX}${path}`, {
    ...options,
    headers: {
      ...(options.headers || {}),
      'X-Ollama-Target': ollamaUrl,
    },
  });
}

export const LLMProvider = ({ children }) => {
  const [state, dispatch] = useReducer(llmReducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;

  const checkConnection = useCallback(async (urlOverride) => {
    const url = urlOverride || stateRef.current.ollamaUrl;
    try {
      const res = await makeOllamaFetch(url, '/api/tags', {
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) {
        const data = await res.json();
        const names = (data.models || []).map(m => m.name);
        dispatch({ type: 'SET_ONLINE', payload: true });
        dispatch({ type: 'SET_MODELS', payload: names });
        if (names.length > 0 && !names.includes(stateRef.current.model)) {
          dispatch({ type: 'SET_MODEL', payload: names[0] });
        }
      } else {
        dispatch({ type: 'SET_ONLINE', payload: false });
      }
    } catch {
      dispatch({ type: 'SET_ONLINE', payload: false });
    }
  }, []);

  useEffect(() => {
    checkConnection(state.ollamaUrl);
    const interval = setInterval(() => checkConnection(), 20000);
    return () => clearInterval(interval);
  }, [state.ollamaUrl, checkConnection]);

  return (
    <LLMContext.Provider value={{ state, dispatch, checkConnection }}>
      {children}
    </LLMContext.Provider>
  );
};

export default LLMContext;
