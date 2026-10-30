package plugin

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"testing"
)

func TestManifestHTTP(t *testing.T) {
	req := ManagementRequestPayload{
		Method: http.MethodGet,
		Path:   "/v0/management/auto-switcher-pro/manifest",
	}

	rawResp, err := handleManifestHTTP(req)
	if err != nil {
		t.Fatalf("handleManifestHTTP error: %v", err)
	}

	var envelope struct {
		Result struct {
			StatusCode int    `json:"StatusCode"`
			Body       string `json:"Body"`
		} `json:"result"`
	}
	if err := json.Unmarshal(rawResp, &envelope); err != nil {
		t.Fatalf("unmarshal envelope error: %v, raw: %s", err, string(rawResp))
	}

	if envelope.Result.StatusCode != http.StatusOK {
		t.Fatalf("expected status 200, got %d", envelope.Result.StatusCode)
	}

	bodyBytes, err := base64.StdEncoding.DecodeString(envelope.Result.Body)
	if err != nil {
		t.Fatalf("decode body error: %v", err)
	}

	var manifest ManifestResponse
	if err := json.Unmarshal(bodyBytes, &manifest); err != nil {
		t.Fatalf("unmarshal manifest error: %v, raw: %s", err, string(bodyBytes))
	}

	t.Logf("decoded manifest body: %s", string(bodyBytes))

	if !manifest.OK {
		t.Errorf("expected manifest.OK to be true")
	}

	if manifest.Epoch == "" {
		t.Errorf("expected non-empty epoch")
	}

	if manifest.Lifecycles == nil {
		t.Errorf("expected non-nil Lifecycles map in manifest")
	}
}
