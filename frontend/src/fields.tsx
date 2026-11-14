import { ApiError } from './api';
import { Icon } from './icons';

export function ErrorNote({ error }: { error: Error }) {
  return (
    <p class="error-note" role="alert">
      <Icon name="alert" />
      <span>
        {error.message}
        {error instanceof ApiError && error.correlationId && (
          <>
            {' '}
            <span class="muted">
              Referência <code>{error.correlationId}</code>
            </span>
          </>
        )}
      </span>
    </p>
  );
}

export function AmountField({
  id,
  label,
  value,
  onInput,
  error,
}: {
  id: string;
  label: string;
  value: string;
  onInput: (value: string) => void;
  error?: string;
}) {
  return (
    <div class="field">
      <label for={id}>{label}</label>
      <div class={`money-input${error ? ' invalid' : ''}`}>
        <span aria-hidden="true">R$</span>
        <input
          id={id}
          inputMode="decimal"
          autoComplete="off"
          value={value}
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={error ? `${id}-error` : `${id}-help`}
          onInput={(event) => onInput(event.currentTarget.value)}
        />
      </div>
      {error ? (
        <small id={`${id}-error`} class="field-error">
          {error}
        </small>
      ) : (
        <small id={`${id}-help`}>Em reais, com vírgula nos centavos.</small>
      )}
    </div>
  );
}
