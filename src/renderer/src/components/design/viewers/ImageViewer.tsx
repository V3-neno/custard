import type { ViewerProps } from './types'

// Placeholder until Workstream B replaces it.
export default function ImageViewer(props: ViewerProps): React.JSX.Element {
  return <p className="text-sm text-ash-400">{props.artifact.name}</p>
}
