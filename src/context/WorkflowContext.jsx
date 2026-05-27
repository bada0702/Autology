import React, { createContext, useReducer } from 'react';

const WorkflowContext = createContext();

const initialState = {
  currentStep: 1,
  completedSteps: [],
  data: {
    problemDefinition: '',
    goals: '',
    rawData: '',
    files: [],
    extractedEntities: [],
  },
};

function workflowReducer(state, action) {
  switch (action.type) {
    case 'SET_STEP':
      return { ...state, currentStep: action.payload };
    case 'COMPLETE_STEP':
      return { 
        ...state, 
        completedSteps: Array.from(new Set([...state.completedSteps, action.payload])) 
      };
    case 'UPDATE_DATA':
      return { 
        ...state, 
        data: { ...state.data, ...action.payload } 
      };
    case 'RESET_WORKFLOW':
      return initialState;
    default:
      return state;
  }
}

export const WorkflowProvider = ({ children }) => {
  const [state, dispatch] = useReducer(workflowReducer, initialState);
  return (
    <WorkflowContext.Provider value={{ state, dispatch }}>
      {children}
    </WorkflowContext.Provider>
  );
};

export default WorkflowContext;
