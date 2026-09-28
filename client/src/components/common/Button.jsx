import styles from './Button.module.css';

export default function Button({
  variant = 'secondary',
  size = 'md',
  icon: Icon,
  iconOnly = false,
  className = '',
  children,
  ...rest
}) {
  const cls = [styles.btn, styles[variant], styles[size], iconOnly && styles.iconOnly, className]
    .filter(Boolean)
    .join(' ');
  return (
    <button type="button" className={cls} {...rest}>
      {Icon && <Icon size={size === 'sm' ? 14 : 15} strokeWidth={2} aria-hidden="true" />}
      {iconOnly ? <span className="visually-hidden">{children}</span> : children}
    </button>
  );
}
