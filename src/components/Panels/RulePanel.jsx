import React, { useContext, useState } from 'react';
import RuleContext from '../../context/RuleContext';
import { useRuleEngine } from '../../hooks/useRuleEngine';
import './RulePanel.css';

const RULE_TYPES = [
  { value: 'transitivity', label: '추이 (Transitivity)', desc: 'A→B AND B→C → A→C' },
  { value: 'inverse',      label: '역관계 (Inverse)',    desc: 'A→B → B→A (역방향)' },
  { value: 'domain',       label: '도메인 (Domain)',     desc: '관계 source 타입 제약 + rdf:type 추론' },
  { value: 'range',        label: '레인지 (Range)',      desc: '관계 target 타입 제약 + rdf:type 추론' },
  { value: 'subclass',     label: '하위 클래스',          desc: 'A rdfs:subClassOf B + 타입 상속' },
  { value: 'equivalentClass', label: '동치 클래스',       desc: 'A owl:equivalentClass B + 타입 공유' },
  { value: 'disjointWith', label: '서로소 클래스',        desc: 'A와 B에 동시 소속 금지' },
  { value: 'cardinality',  label: '카디널리티',           desc: '관계 개수 min/max 제약' },
  { value: 'custom',       label: '사용자 정의',          desc: 'IF/THEN 텍스트 규칙' },
];

const EMPTY_FORM = {
  type: 'transitivity',
  label: '',
  edgeLabel: '',
  conclusionLabel: '',
  sourceLabel: '',
  inverseLabel: '',
  domainClass: '',
  rangeClass: '',
  childClass: '',
  parentClass: '',
  leftClass: '',
  rightClass: '',
  minCardinality: '',
  maxCardinality: '',
  condition: '',
  conclusion: '',
};

export default function RulePanel() {
  const { state, dispatch } = useContext(RuleContext);
  const { apply, clearInferred, inferredCount, semanticViolations } = useRuleEngine();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);

  const handleAdd = () => {
    if (!form.label.trim()) return;
    dispatch({
      type: 'ADD_RULE',
      payload: { id: `rule_${Date.now()}`, ...form, active: true },
    });
    setForm(EMPTY_FORM);
    setShowForm(false);
  };

  const set = (key, val) => setForm(f => ({ ...f, [key]: val }));

  return (
    <div className="rule-panel">
      <div className="rule-header">
        <span className="rule-title">규칙 엔진</span>
        {inferredCount > 0 && (
          <span className="rule-badge">⚡ {inferredCount}</span>
        )}
        {semanticViolations.length > 0 && (
          <span className="rule-badge rule-badge--error">{semanticViolations.length} 위반</span>
        )}
      </div>

      <div className="rule-actions">
        <button className="rule-apply-btn" onClick={apply} disabled={state.rules.length === 0}>
          ⚡ 규칙 적용
        </button>
        {inferredCount > 0 && (
          <button className="rule-clear-btn" onClick={clearInferred}>
            × 제거
          </button>
        )}
      </div>

      <div className="rule-list">
        {state.rules.length === 0 && (
          <p className="rule-empty">규칙이 없습니다.</p>
        )}
        {state.rules.map(rule => {
          const typeInfo = RULE_TYPES.find(t => t.value === rule.type);
          return (
            <div key={rule.id} className={`rule-item${rule.active ? '' : ' rule-item--off'}`}>
              <div className="rule-item-top">
                <button
                  className={`rule-toggle${rule.active ? ' rule-toggle--on' : ''}`}
                  onClick={() => dispatch({ type: 'TOGGLE_RULE', payload: rule.id })}
                  title={rule.active ? '비활성화' : '활성화'}
                />
                <div className="rule-item-info">
                  <span className="rule-item-name">{rule.label}</span>
                  <span className="rule-item-desc">{typeInfo?.desc}</span>
                </div>
                <button
                  className="rule-del-btn"
                  onClick={() => dispatch({ type: 'DELETE_RULE', payload: rule.id })}
                  title="삭제"
                >×</button>
              </div>
              <div className="rule-item-detail">
                {rule.type === 'transitivity' && (
                  <span>
                    [{rule.edgeLabel || '*'}] → [{rule.conclusionLabel || '동일'}]
                  </span>
                )}
                {rule.type === 'inverse' && (
                  <span>
                    [{rule.sourceLabel || '*'}] ↔ [{rule.inverseLabel || 'inverse'}]
                  </span>
                )}
                {rule.type === 'domain' && (
                  <span>[{rule.edgeLabel || rule.sourceLabel || '*'}] domain {rule.domainClass || rule.conclusion || '?'}</span>
                )}
                {rule.type === 'range' && (
                  <span>[{rule.edgeLabel || rule.sourceLabel || '*'}] range {rule.rangeClass || rule.conclusion || '?'}</span>
                )}
                {rule.type === 'subclass' && (
                  <span>{rule.childClass || rule.condition || '?'} ⊑ {rule.parentClass || rule.conclusion || '?'}</span>
                )}
                {rule.type === 'equivalentClass' && (
                  <span>{rule.leftClass || rule.condition || '?'} ≡ {rule.rightClass || rule.conclusion || '?'}</span>
                )}
                {rule.type === 'disjointWith' && (
                  <span>{rule.leftClass || rule.condition || '?'} disjointWith {rule.rightClass || rule.conclusion || '?'}</span>
                )}
                {rule.type === 'cardinality' && (
                  <span>
                    {rule.domainClass || '*'} [{rule.edgeLabel || rule.sourceLabel || '?'}] min {rule.minCardinality || '0'} max {rule.maxCardinality || '*'}
                  </span>
                )}
                {rule.type === 'custom' && (
                  <span>{rule.condition} → {rule.conclusion}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {showForm ? (
        <div className="rule-form">
          <div className="rule-form-row">
            <label>규칙 이름</label>
            <input
              className="rule-input"
              placeholder="예: 추이 관계"
              value={form.label}
              onChange={e => set('label', e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleAdd(); if (e.key === 'Escape') setShowForm(false); }}
              autoFocus
            />
          </div>

          <div className="rule-form-row">
            <label>유형</label>
            <select
              className="rule-select"
              value={form.type}
              onChange={e => set('type', e.target.value)}
            >
              {RULE_TYPES.map(t => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>

          {form.type === 'transitivity' && (
            <>
              <div className="rule-form-row">
                <label>대상 엣지 레이블 <span className="rule-opt">(비우면 모든 엣지)</span></label>
                <input className="rule-input" placeholder="예: part-of"
                  value={form.edgeLabel} onChange={e => set('edgeLabel', e.target.value)} />
              </div>
              <div className="rule-form-row">
                <label>추론 레이블 <span className="rule-opt">(비우면 동일)</span></label>
                <input className="rule-input" placeholder="예: transitively-part-of"
                  value={form.conclusionLabel} onChange={e => set('conclusionLabel', e.target.value)} />
              </div>
            </>
          )}

          {form.type === 'inverse' && (
            <>
              <div className="rule-form-row">
                <label>원본 레이블</label>
                <input className="rule-input" placeholder="예: parent-of"
                  value={form.sourceLabel} onChange={e => set('sourceLabel', e.target.value)} />
              </div>
              <div className="rule-form-row">
                <label>역관계 레이블</label>
                <input className="rule-input" placeholder="예: child-of"
                  value={form.inverseLabel} onChange={e => set('inverseLabel', e.target.value)} />
              </div>
            </>
          )}

          {(form.type === 'domain' || form.type === 'range') && (
            <>
              <div className="rule-form-row">
                <label>관계 레이블</label>
                <input className="rule-input" placeholder="예: authored-by"
                  value={form.edgeLabel} onChange={e => set('edgeLabel', e.target.value)} />
              </div>
              {form.type === 'domain' && (
                <div className="rule-form-row">
                  <label>Domain 클래스</label>
                  <input className="rule-input" placeholder="예: Person"
                    value={form.domainClass} onChange={e => set('domainClass', e.target.value)} />
                </div>
              )}
              {form.type === 'range' && (
                <div className="rule-form-row">
                  <label>Range 클래스</label>
                  <input className="rule-input" placeholder="예: Organization"
                    value={form.rangeClass} onChange={e => set('rangeClass', e.target.value)} />
                </div>
              )}
            </>
          )}

          {form.type === 'subclass' && (
            <>
              <div className="rule-form-row">
                <label>하위 클래스</label>
                <input className="rule-input" placeholder="예: Researcher"
                  value={form.childClass} onChange={e => set('childClass', e.target.value)} />
              </div>
              <div className="rule-form-row">
                <label>상위 클래스</label>
                <input className="rule-input" placeholder="예: Person"
                  value={form.parentClass} onChange={e => set('parentClass', e.target.value)} />
              </div>
            </>
          )}

          {(form.type === 'equivalentClass' || form.type === 'disjointWith') && (
            <>
              <div className="rule-form-row">
                <label>클래스 A</label>
                <input className="rule-input" placeholder="예: Author"
                  value={form.leftClass} onChange={e => set('leftClass', e.target.value)} />
              </div>
              <div className="rule-form-row">
                <label>클래스 B</label>
                <input className="rule-input" placeholder="예: Writer"
                  value={form.rightClass} onChange={e => set('rightClass', e.target.value)} />
              </div>
            </>
          )}

          {form.type === 'cardinality' && (
            <>
              <div className="rule-form-row">
                <label>대상 클래스 <span className="rule-opt">(비우면 전체)</span></label>
                <input className="rule-input" placeholder="예: Person"
                  value={form.domainClass} onChange={e => set('domainClass', e.target.value)} />
              </div>
              <div className="rule-form-row">
                <label>관계 레이블</label>
                <input className="rule-input" placeholder="예: hasEmail"
                  value={form.edgeLabel} onChange={e => set('edgeLabel', e.target.value)} />
              </div>
              <div className="rule-form-grid">
                <div className="rule-form-row">
                  <label>Min</label>
                  <input className="rule-input" type="number" min="0"
                    value={form.minCardinality} onChange={e => set('minCardinality', e.target.value)} />
                </div>
                <div className="rule-form-row">
                  <label>Max</label>
                  <input className="rule-input" type="number" min="0"
                    value={form.maxCardinality} onChange={e => set('maxCardinality', e.target.value)} />
                </div>
              </div>
            </>
          )}

          {form.type === 'custom' && (
            <>
              <div className="rule-form-row">
                <label>조건 (IF)</label>
                <input className="rule-input" placeholder="예: type = Class"
                  value={form.condition} onChange={e => set('condition', e.target.value)} />
              </div>
              <div className="rule-form-row">
                <label>결론 (THEN)</label>
                <input className="rule-input" placeholder="예: has-subclass 적용"
                  value={form.conclusion} onChange={e => set('conclusion', e.target.value)} />
              </div>
            </>
          )}

          <div className="rule-form-btns">
            <button className="rule-submit-btn" onClick={handleAdd}>추가</button>
            <button className="rule-cancel-btn" onClick={() => { setShowForm(false); setForm(EMPTY_FORM); }}>취소</button>
          </div>
        </div>
      ) : (
        <button className="rule-add-btn" onClick={() => setShowForm(true)}>
          + 규칙 추가
        </button>
      )}

      {semanticViolations.length > 0 && (
        <div className="rule-violations">
          <div className="rule-violations-title">의미론 제약 위반</div>
          {semanticViolations.slice(0, 8).map((v, i) => (
            <div key={`${v.ruleId}_${i}`} className={`rule-violation rule-violation--${v.severity}`}>
              <span>{v.severity === 'error' ? '!' : '?'}</span>
              <p>{v.message}</p>
            </div>
          ))}
          {semanticViolations.length > 8 && (
            <div className="rule-violations-more">+{semanticViolations.length - 8}개 더</div>
          )}
        </div>
      )}
    </div>
  );
}
