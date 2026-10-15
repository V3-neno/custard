// The one dropdown for lists (docs/ui-dropdowns.md): a native <select>, so
// keyboard, type-ahead and screen readers work as they do everywhere, drawn
// in the forge style by the `.select` rules in main.css (Chromium's
// customizable select). The chat box's model picker is not this; it stays
// as it is.

type Props = React.SelectHTMLAttributes<HTMLSelectElement> & {
  ref?: React.Ref<HTMLSelectElement>
}

export default function Select({ className = '', ...rest }: Props): React.JSX.Element {
  return <select {...rest} className={`select ${className}`} />
}
