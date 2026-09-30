import type { ButtonHTMLAttributes, ReactNode } from 'react'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-indigo-600 text-white hover:bg-indigo-500 active:bg-indigo-700 shadow-sm disabled:bg-indigo-600/50',
  secondary:
    'bg-slate-200 text-slate-800 hover:bg-slate-300 dark:bg-slate-700/70 dark:text-slate-100 dark:hover:bg-slate-600/70',
  ghost:
    'bg-transparent text-slate-600 hover:bg-slate-200/70 dark:text-slate-300 dark:hover:bg-slate-700/50',
  danger: 'bg-rose-600 text-white hover:bg-rose-500 active:bg-rose-700'
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  icon?: ReactNode
}

export function Button({
  variant = 'secondary',
  icon,
  children,
  className = '',
  ...rest
}: ButtonProps): React.JSX.Element {
  return (
    <button
      className={`inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${VARIANTS[variant]} ${className}`}
      {...rest}
    >
      {icon}
      {children}
    </button>
  )
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
}

export function IconButton({
  label,
  children,
  className = '',
  ...rest
}: IconButtonProps): React.JSX.Element {
  return (
    <button
      title={label}
      aria-label={label}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-200/70 hover:text-slate-800 disabled:opacity-50 dark:text-slate-400 dark:hover:bg-slate-700/60 dark:hover:text-slate-100 ${className}`}
      {...rest}
    >
      {children}
    </button>
  )
}
