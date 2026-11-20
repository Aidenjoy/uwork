/** Neutral animated spinner for the running Chat status. */
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './ChatView.module.css'

/**
 * Render the decorative running indicator.
 * @returns neutral loading spinner sized to the running status line.
 */
export function RunningWhaleTail() {
  return (
    <span className={css.runningIcon} aria-hidden="true">
      <StateDot state="ongoing" className={css.runningSpinner} />
    </span>
  )
}
