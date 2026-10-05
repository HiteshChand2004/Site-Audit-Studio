import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import InfoTip from './InfoTip.jsx';
import styles from './Surface.module.css';

/**
 * A card: optional icon, title, a one-line explanation under it, an "i" tip, and actions on the right.
 * `flush` removes the body padding (for lists and tables that bring their own).
 */
export function Card({ icon: Icon, title, sub, tip, actions, flush = false, className = '', children, ...rest }) {
  const hasHead = Icon || title || actions;
  return (
    <section className={[styles.card, flush && styles.flush, className].filter(Boolean).join(' ')} {...rest}>
      {hasHead && (
        <header className={styles.cardHead}>
          {Icon && (
            <span className={styles.cardIcon} aria-hidden="true">
              <Icon size={18} />
            </span>
          )}
          <div className={styles.cardTitles}>
            {title && (
              <h3 className={styles.cardTitle}>
                {title}
                {tip && <InfoTip label={typeof title === 'string' ? title : 'More information'}>{tip}</InfoTip>}
              </h3>
            )}
            {sub && <p className={styles.cardSub}>{sub}</p>}
          </div>
          {actions && <div className={styles.cardActions}>{actions}</div>}
        </header>
      )}
      {children != null && children !== false && <div className={styles.cardBody}>{children}</div>}
    </section>
  );
}

const ALERT_ICONS = { info: Info, ok: CheckCircle2, warn: AlertTriangle, bad: XCircle, neutral: Info };

/** A calm message box: tone info | ok | warn | bad | neutral. */
export function Alert({ tone = 'info', title, action, children, className = '' }) {
  const Icon = ALERT_ICONS[tone] ?? Info;
  return (
    <div className={[styles.alert, className].filter(Boolean).join(' ')} data-tone={tone} role={tone === 'bad' ? 'alert' : 'status'}>
      <Icon size={18} aria-hidden="true" />
      <div>
        {title && <p className={styles.alertTitle}>{title}</p>}
        {children && <div className={styles.alertText}>{children}</div>}
      </div>
      {action ?? <span />}
    </div>
  );
}

/** What to show when there is nothing yet, and what to do about it. */
export function EmptyState({ icon: Icon = Info, title, children, action }) {
  return (
    <div className={styles.empty}>
      <span className={styles.emptyIcon} aria-hidden="true">
        <Icon size={22} />
      </span>
      <p className={styles.emptyTitle}>{title}</p>
      {children && <p className={styles.emptyText}>{children}</p>}
      {action && <div className={styles.emptyAction}>{action}</div>}
    </div>
  );
}
