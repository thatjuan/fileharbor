import { Fragment, type ReactNode, cloneElement, isValidElement } from 'react';

import { useLocaleContext } from './LocaleProvider.js';
import { translate, type TranslateVars } from './useT.js';

interface TransProps {
  /** Catalog key. */
  k: string;
  /**
   * React-node slots keyed by placeholder name. The matching `{name}` token
   * in the translated string is replaced with the node.
   */
  components?: Record<string, ReactNode>;
  /** Scalar variables for `{name}` placeholders. */
  vars?: TranslateVars;
}

/**
 * Render a translation that contains React-node placeholders such as
 * `<strong>{label}</strong>`. The translated template is tokenised on
 * `{name}` slots; slots matching `components[name]` render as that node,
 * slots matching `vars[name]` render as the scalar value, and unknown
 * slots render literally (e.g. `{unknown}`).
 *
 * Whitespace, punctuation, and surrounding text outside `{...}` markers
 * are preserved verbatim — translators can move slot positions to match
 * each language's natural word order without code changes.
 */
export function Trans({ k, components, vars }: TransProps): JSX.Element {
  const { catalog } = useLocaleContext();
  // Use translate without interpolation; we tokenise the raw template so
  // React nodes can be threaded in at the matching positions.
  const template = translate(catalog, k);
  const parts = template.split(/(\{\w+\})/g);
  return (
    <>
      {parts.map((part, i) => {
        const slotMatch = /^\{(\w+)\}$/.exec(part);
        if (slotMatch) {
          const name = slotMatch[1] ?? '';
          if (components && Object.prototype.hasOwnProperty.call(components, name)) {
            const node = components[name];
            return isValidElement(node) ? (
              cloneElement(node, { key: i })
            ) : (
              <Fragment key={i}>{node}</Fragment>
            );
          }
          if (vars && Object.prototype.hasOwnProperty.call(vars, name)) {
            return <Fragment key={i}>{String(vars[name])}</Fragment>;
          }
          return <Fragment key={i}>{part}</Fragment>;
        }
        return <Fragment key={i}>{part}</Fragment>;
      })}
    </>
  );
}
