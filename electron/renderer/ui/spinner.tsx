// shadcn/ui Spinner: something is running. It goes beside a word that says what ("Sending…"), and has a name of its own
// for a screen reader.

import type { ComponentProps } from 'react';
import { Loader2Icon } from 'lucide-react';
import { cn } from '@/lib/utils';

export function Spinner({ className, ...props }: ComponentProps<'svg'>) {
    return <Loader2Icon role="status" aria-label="Loading" className={cn('size-4 animate-spin', className)} {...props} />;
}
