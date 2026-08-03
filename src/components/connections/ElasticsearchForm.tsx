import { AlertTriangle } from "lucide-react";

interface ElasticsearchFormProps {
  dangerouslyIgnoreTls: boolean;
  onChange: (dangerouslyIgnoreTls: boolean) => void;
}

export function ElasticsearchForm({
  dangerouslyIgnoreTls,
  onChange,
}: ElasticsearchFormProps) {
  return (
    <div className={`insecure-tls-option form-wide ${dangerouslyIgnoreTls ? "enabled" : ""}`}>
      <label>
        <input
          type="checkbox"
          checked={dangerouslyIgnoreTls}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="checkbox-control" aria-hidden="true" />
        <span className="insecure-tls-copy">
          <strong>Insecure / Ignore TLS Certificate Verification</strong>
          <code>dangerously_ignore_tls</code>
        </span>
      </label>
      <p>
        <AlertTriangle size={13} />
        Use only for local development or self-signed development clusters. Server identity will
        not be verified.
      </p>
    </div>
  );
}
