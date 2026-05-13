package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
)

type rangeQueryResponse struct {
	Status string `json:"status"`
	Data   struct {
		Result []struct {
			Values [][2]any `json:"values"`
		} `json:"result"`
	} `json:"data"`
}

type fakeStatusResponse struct {
	VirtualNow float64 `json:"virtual_now"`
}

func averageTTFT(t *testing.T, baseURL string) float64 {
	t.Helper()
	statusResp, err := http.Get(baseURL + "/_fake/status")
	if err != nil {
		t.Fatalf("status failed: %v", err)
	}
	defer statusResp.Body.Close()
	var status fakeStatusResponse
	if err := json.NewDecoder(statusResp.Body).Decode(&status); err != nil {
		t.Fatalf("decode status response: %v", err)
	}
	now := status.VirtualNow

	query := url.QueryEscape("vllm:time_to_first_token_seconds")
	resp, err := http.Get(baseURL + "/api/v1/query_range?query=" + query + "&start=" + strconv.FormatFloat(now-300, 'f', 0, 64) + "&end=" + strconv.FormatFloat(now, 'f', 0, 64) + "&step=60")
	if err != nil {
		t.Fatalf("query_range failed: %v", err)
	}
	defer resp.Body.Close()

	var parsed rangeQueryResponse
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		t.Fatalf("decode query_range response: %v", err)
	}
	if len(parsed.Data.Result) != 1 {
		t.Fatalf("expected one series, got %d", len(parsed.Data.Result))
	}
	values := parsed.Data.Result[0].Values
	if len(values) == 0 {
		t.Fatal("expected range values")
	}

	var sum float64
	for _, pair := range values {
		raw, ok := pair[1].(string)
		if !ok {
			t.Fatalf("expected string sample value, got %T", pair[1])
		}
		value, err := strconv.ParseFloat(raw, 64)
		if err != nil {
			t.Fatalf("parse sample value %q: %v", raw, err)
		}
		sum += value
	}
	return sum / float64(len(values))
}

func postJSON(t *testing.T, target string, body string) {
	t.Helper()
	resp, err := http.Post(target, "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("POST %s failed: %v", target, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("POST %s returned status %d", target, resp.StatusCode)
	}
}

func TestActionSuppressesAnomalyUntilRecovery(t *testing.T) {
	store := newMetricsStore(5, 0, 0, false)
	server := &fakePromServer{store: store, deploymentCount: 1}
	ts := httptest.NewServer(server.handler())
	defer ts.Close()

	postJSON(t, ts.URL+"/_fake/recover-anomaly", `{}`)
	if avg := averageTTFT(t, ts.URL); avg < 0.35 {
		t.Fatalf("expected recovered anomaly TTFT average >= 0.35s, got %.3fs", avg)
	}

	postJSON(t, ts.URL+"/_fake/action", `{"action":"restart","deploymentName":"minimax-m25-tp8ep"}`)
	if avg := averageTTFT(t, ts.URL); avg > 0.20 {
		t.Fatalf("expected remediated TTFT average <= 0.20s, got %.3fs", avg)
	}

	postJSON(t, ts.URL+"/_fake/recover-anomaly", `{}`)
	if avg := averageTTFT(t, ts.URL); avg < 0.35 {
		t.Fatalf("expected recovered anomaly TTFT average >= 0.35s, got %.3fs", avg)
	}
}
