import type { ViewerProps } from './types'

// Placeholder until Workstream C replaces it.
export default function VideoViewer(props: ViewerProps): React.JSX.Element {
  return <p className="text-sm text-ash-400">{props.artifact.name}</p>
}
