import { Count } from '@/components/ui';
import { Ico } from '@/components/ui/Ico';
import { WHAT_IT_DOES, WHY, WHY_VISUAL } from '@/lib/content';

/** Three cards: what the product does. They rise one after another. */
export function WhatItDoes() {
  return (
    <ul className={`fgrid fgrid--${WHAT_IT_DOES.length}`} data-stagger>
      {WHAT_IT_DOES.map((w) => (
        <li key={w.title} className="wcard">
          <span className="itile">
            <Ico name={w.icon} size={24} />
          </span>
          <h3>{w.title}</h3>
          <p>{w.text}</p>
        </li>
      ))}
    </ul>
  );
}

/** The 2 × 2 grid of the dark band (items rise one after another), with real counts under it. */
export function WhyGrid() {
  return (
    <div className="why">
      <div className="why__main">
        <ul className="fgrid fgrid--2" data-stagger>
          {WHY.items.map((w) => (
            <li key={w.title} className="fitem">
              <span className="itile">
                <Ico name={w.icon} size={24} />
              </span>
              <h3>{w.title}</h3>
              <p>{w.text}</p>
            </li>
          ))}
        </ul>
        <dl className="why__stats" data-reveal>
          {WHY.stats.map((s) => (
            <div key={s.label}>
              <dt className="display">
                <Count to={s.value} />
              </dt>
              <dd>{s.label}</dd>
            </div>
          ))}
        </dl>
        <p className="why__note">{WHY.statsNote}</p>
      </div>
      <div className="why__slotwrap" data-reveal>
        <div className="wv" data-loop aria-hidden="true">
          <div className="wv__win">
            <div className="wv__bar">
              <i />
              <i />
              <i />
              <span>{WHY_VISUAL.addr}</span>
            </div>
            <div className="wv__page">
              <div className="wv__nav">
                <b />
                <s />
                <s />
                <s />
              </div>
              <div className="wv__h1" />
              <div className="wv__h2" />
              <div className="wv__p" />
              <div className="wv__p wv__p--short" />
              <div className="wv__row">
                <span className="wv__btn">{WHY_VISUAL.button}</span>
                <span className="wv__img" />
              </div>
            </div>
            <i className="wv__scan" />
          </div>
          <span className="wv__chip wv__chip--match">
            <svg viewBox="0 0 16 16">
              <path d="M3.5 8.5l3 3 6-7" />
            </svg>
            {WHY_VISUAL.chips.match}
          </span>
          <span className="wv__chip wv__chip--hover">
            <svg viewBox="0 0 16 16">
              <path d="M4 2l8 6-3.5 1 2 4-1.8.9-2-4L4 12z" />
            </svg>
            {WHY_VISUAL.chips.hover}
          </span>
          <span className="wv__chip wv__chip--worse">
            <i />
            {WHY_VISUAL.chips.worse}
          </span>
          <svg className="wv__cursor" viewBox="0 0 16 16">
            <path d="M3 2l9 6.5-4 1 2.2 4.5-2 1-2.2-4.5L3 13z" />
          </svg>
          <div className="wv__rep">
            <strong>{WHY_VISUAL.report.title}</strong>
            {WHY_VISUAL.report.lines.map((l) => (
              <span key={l}>
                <i />
                {l}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
