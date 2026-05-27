import React, { createContext, useReducer } from 'react';

const RuleContext = createContext();

const initialState = {
  rules: [],
};

function ruleReducer(state, action) {
  switch (action.type) {
    case 'ADD_RULE':
      return { ...state, rules: [...state.rules, action.payload] };
    case 'UPDATE_RULE':
      return {
        ...state,
        rules: state.rules.map(r =>
          r.id === action.payload.id ? { ...r, ...action.payload.updates } : r
        ),
      };
    case 'DELETE_RULE':
      return { ...state, rules: state.rules.filter(r => r.id !== action.payload) };
    case 'TOGGLE_RULE':
      return {
        ...state,
        rules: state.rules.map(r =>
          r.id === action.payload ? { ...r, active: !r.active } : r
        ),
      };
    case 'LOAD_RULES':
      return { ...state, rules: action.payload || [] };
    default:
      return state;
  }
}

export const RuleProvider = ({ children }) => {
  const [state, dispatch] = useReducer(ruleReducer, initialState);
  return (
    <RuleContext.Provider value={{ state, dispatch }}>
      {children}
    </RuleContext.Provider>
  );
};

export default RuleContext;
