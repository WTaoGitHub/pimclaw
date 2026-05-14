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
	VirtualNow          float64        `json:"virtual_now"`
	Phase               string         `json:"phase"`
	ForceAnomaly        bool           `json:"force_anomaly"`
	Remediated          bool           `json:"remediated"`
	AnomalyMetrics      []string       `json:"anomaly_metrics"`
	MaxPointsPerMetric  int            `json:"max_points_per_metric"`
	DataPointsPerMetric map[string]int `json:"data_points_per_metric"`
}

var metricQueries = map[string]string{
	"ttft":            "vllm:time_to_first_token_seconds",
	"tpot":            "vllm:request_time_per_output_token_seconds",
	"qps":             "sum(rate(vllm:request_success_total[5m]))",
	"throughput":      "sum(rate(vllm:generation_tokens_total[5m]))",
	"gpu_utilization": "vllm:kv_cache_usage_perc",
	"error_rate":      `sum(rate(vllm:request_success_total{finished_reason="error"}[5m])) / sum(rate(vllm:request_success_total[5m])) * 100`,
}

func averageMetric(t *testing.T, baseURL string, query string) float64 {
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

	resp, err := http.Get(baseURL + "/api/v1/query_range?query=" + url.QueryEscape(query) + "&start=" + strconv.FormatFloat(now-300, 'f', 0, 64) + "&end=" + strconv.FormatFloat(now, 'f', 0, 64) + "&step=60")
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

func averageTTFT(t *testing.T, baseURL string) float64 {
	t.Helper()
	return averageMetric(t, baseURL, metricQueries["ttft"])
}

func getStatus(t *testing.T, baseURL string) fakeStatusResponse {
	t.Helper()
	resp, err := http.Get(baseURL + "/_fake/status")
	if err != nil {
		t.Fatalf("status failed: %v", err)
	}
	defer resp.Body.Close()
	var status fakeStatusResponse
	if err := json.NewDecoder(resp.Body).Decode(&status); err != nil {
		t.Fatalf("decode status response: %v", err)
	}
	return status
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

func isSelected(metric string, selected []string) bool {
	for _, item := range selected {
		if item == metric {
			return true
		}
	}
	return false
}

func metricIsAbnormal(metric string, avg float64) bool {
	switch metric {
	case "ttft":
		return avg > 10.0
	case "tpot":
		return avg > 0.5
	case "throughput":
		return avg < 1.5
	case "gpu_utilization":
		return avg < 0.70
	case "error_rate":
		return avg > 10.0
	default:
		return false
	}
}

func TestActionSwitchesToNormalMode(t *testing.T) {
	store := newMetricsStore(5, 0, 0, false)
	server := &fakePromServer{store: store, deploymentCount: 1}
	ts := httptest.NewServer(server.handler())
	defer ts.Close()

	postJSON(t, ts.URL+"/_fake/mode", `{"mode":"anomaly"}`)
	status := getStatus(t, ts.URL)
	if len(status.AnomalyMetrics) < 1 || len(status.AnomalyMetrics) > 2 {
		t.Fatalf("expected one or two anomaly metrics, got %v", status.AnomalyMetrics)
	}

	postJSON(t, ts.URL+"/_fake/action", `{"action":"restart","deploymentName":"minimax-m25-tp8ep"}`)
	status = getStatus(t, ts.URL)
	if status.Phase != "NORMAL" || status.ForceAnomaly || status.Remediated {
		t.Fatalf("expected action to equal mode=normal, got phase=%s force_anomaly=%t remediated=%t", status.Phase, status.ForceAnomaly, status.Remediated)
	}
	if len(status.AnomalyMetrics) != 0 {
		t.Fatalf("expected action normal mode to clear anomaly metrics, got %v", status.AnomalyMetrics)
	}
	if avg := averageTTFT(t, ts.URL); avg > 0.20 {
		t.Fatalf("expected action normal TTFT average <= 0.20s, got %.3fs", avg)
	}
	if avg := averageTTFT(t, ts.URL); avg > 0.20 {
		t.Fatalf("expected action normal mode to persist across range-query cycles, got %.3fs", avg)
	}
}

func TestStartsNormalWithOneDayHistory(t *testing.T) {
	store := newMetricsStore(5, 0, 0, false)
	server := &fakePromServer{store: store, deploymentCount: 1}
	ts := httptest.NewServer(server.handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/_fake/status")
	if err != nil {
		t.Fatalf("status failed: %v", err)
	}
	defer resp.Body.Close()

	var status fakeStatusResponse
	if err := json.NewDecoder(resp.Body).Decode(&status); err != nil {
		t.Fatalf("decode status response: %v", err)
	}
	if status.Phase != "NORMAL" {
		t.Fatalf("expected initial NORMAL phase, got %s", status.Phase)
	}
	if status.MaxPointsPerMetric != 5760 {
		t.Fatalf("expected 5760 max points per metric, got %d", status.MaxPointsPerMetric)
	}
	for _, metric := range []string{"ttft", "tpot", "qps", "throughput", "gpu_utilization", "error_rate"} {
		if got := status.DataPointsPerMetric[metric]; got != 5760 {
			t.Fatalf("expected %s to start with 5760 history points, got %d", metric, got)
		}
	}
	if avg := averageTTFT(t, ts.URL); avg > 0.20 {
		t.Fatalf("expected initial normal TTFT average <= 0.20s, got %.3fs", avg)
	}
}

func TestModeAPI(t *testing.T) {
	store := newMetricsStore(5, 0, 0, false)
	server := &fakePromServer{store: store, deploymentCount: 1}
	ts := httptest.NewServer(server.handler())
	defer ts.Close()

	postJSON(t, ts.URL+"/_fake/mode", `{"mode":"anomaly"}`)
	status := getStatus(t, ts.URL)
	if status.Phase != "ANOMALY" {
		t.Fatalf("expected ANOMALY phase, got %s", status.Phase)
	}
	if len(status.AnomalyMetrics) < 1 || len(status.AnomalyMetrics) > 2 {
		t.Fatalf("expected one or two anomaly metrics, got %v", status.AnomalyMetrics)
	}
	abnormalCount := 0
	for _, metric := range []string{"ttft", "tpot", "throughput", "gpu_utilization", "error_rate"} {
		avg := averageMetric(t, ts.URL, metricQueries[metric])
		abnormal := metricIsAbnormal(metric, avg)
		if isSelected(metric, status.AnomalyMetrics) {
			if !abnormal {
				t.Fatalf("expected selected metric %s to be abnormal, avg %.3f", metric, avg)
			}
			abnormalCount++
		} else if abnormal {
			t.Fatalf("expected unselected metric %s to remain normal, avg %.3f", metric, avg)
		}
	}
	if abnormalCount != len(status.AnomalyMetrics) {
		t.Fatalf("expected %d abnormal metrics, counted %d", len(status.AnomalyMetrics), abnormalCount)
	}

	postJSON(t, ts.URL+"/_fake/mode", `{"mode":"normal"}`)
	status = getStatus(t, ts.URL)
	if len(status.AnomalyMetrics) != 0 {
		t.Fatalf("expected normal mode to clear anomaly metrics, got %v", status.AnomalyMetrics)
	}
	if avg := averageTTFT(t, ts.URL); avg > 0.20 {
		t.Fatalf("expected mode=normal TTFT average <= 0.20s, got %.3fs", avg)
	}
}
