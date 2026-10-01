import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const astraButton = cva(
  'inline-flex items-center justify-center gap-2 rounded-full font-medium transition-all duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-40',
  {
    variants: {
      variant: {
        gold: 'bg-star-gold/90 text-primary-foreground shadow-glow-gold hover:bg-star-gold hover:-translate-y-0.5',
        lavender: 'bg-star-lavender/90 text-primary-foreground shadow-glow-lavender hover:bg-star-lavender',
        glass: 'glass text-foreground hover:bg-foreground/10',
        ghost: 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
        danger: 'text-destructive hover:bg-destructive/10',
      },
      size: {
        sm: 'h-9 px-4 text-sm',
        md: 'h-11 px-5 text-sm',
        lg: 'h-14 px-7 text-base',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: { variant: 'glass', size: 'md' },
  },
);

export interface AstraButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof astraButton> {}

const AstraButton = forwardRef<HTMLButtonElement, AstraButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button ref={ref} className={cn(astraButton({ variant, size }), className)} {...props} />
  ),
);
AstraButton.displayName = 'AstraButton';

export default AstraButton;
