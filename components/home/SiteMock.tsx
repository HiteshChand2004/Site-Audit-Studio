/**
 * A small website drawn in HTML/CSS (no image). Sized in em, where 1em is 1/52 of its width, so the same mock
 * works as a hero card, a story stage and a compare card. Blocks carry `blk` so animations can target them.
 * `wire` draws it as a bare wireframe (the site as the audit first sees it).
 */
export default function SiteMock({ className = '', wire = false }: { className?: string; wire?: boolean }) {
  return (
    <div className={`sm${wire ? ' sm--wire' : ''} ${className}`}>
      <div className="sm__page">
        <div className="sm-nav blk">
          <b className="sm-logo" />
          <span />
          <span />
          <span />
          <b className="sm-btn" />
        </div>
        <div className="sm-hero">
          <div className="sm-copy blk">
            <span className="sm-l1" />
            <span className="sm-l2" />
            <span className="sm-t" />
            <span className="sm-t sm-t--short" />
            <b className="sm-cta" />
          </div>
          <div className="sm-art blk">
            <i />
          </div>
        </div>
        <div className="sm-cards">
          <div className="blk" />
          <div className="blk" />
          <div className="blk" />
        </div>
      </div>
    </div>
  );
}
