import { useContext } from 'react';
import GraphContext from '../context/GraphContext';
import RuleContext from '../context/RuleContext';
import { applyRules, validateSemanticRules } from '../utils/ruleEngine';

export function useRuleEngine() {
  const { state: graph, dispatch: graphDispatch } = useContext(GraphContext);
  const { state: ruleState } = useContext(RuleContext);

  function apply() {
    const newInferred = applyRules(graph.nodes, graph.edges, ruleState.rules);
    graphDispatch({ type: 'APPLY_RULES', payload: newInferred });
  }

  function clearInferred() {
    graphDispatch({ type: 'CLEAR_INFERRED' });
  }

  const semanticViolations = validateSemanticRules(graph.nodes, graph.edges, ruleState.rules);

  return {
    apply,
    clearInferred,
    inferredCount: graph.edges.filter(e => e.inferred).length,
    ruleCount: ruleState.rules.length,
    semanticViolations,
  };
}
