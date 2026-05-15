package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"math"
	"math/rand"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

type metricProfile struct {
	Good       float64
	Bad        float64
	VeryBad    float64
	Jitter     float64
	MetricName string
}

var metricProfiles = map[string]metricProfile{
	"ttft": {
		Good:       0.150,
		Bad:        18.0,
		VeryBad:    30.0,
		Jitter:     0.06,
		MetricName: "sglang:time_to_first_token_seconds",
	},
	"tpot": {
		Good:       0.016,
		Bad:        0.900,
		VeryBad:    1.200,
		Jitter:     0.06,
		MetricName: "sglang:inter_token_latency_seconds",
	},
	"qps": {
		Good:       12.0,
		Bad:        4.0,
		VeryBad:    0.2,
		Jitter:     0.10,
		MetricName: "sglang:num_requests_total",
	},
	"throughput": {
		Good:       48,
		Bad:        0.8,
		VeryBad:    0,
		Jitter:     0.08,
		MetricName: "sglang:generation_tokens_total",
	},
	"gpu_utilization": {
		Good:       0.88,
		Bad:        0.48,
		VeryBad:    1.00,
		Jitter:     0.05,
		MetricName: "sglang:token_usage",
	},
	"error_rate": {
		Good:       0.005,
		Bad:        20.0,
		VeryBad:    25.0,
		Jitter:     0.10,
		MetricName: "sglang:num_aborted_requests_total",
	},
}

var metricKeys = []string{"ttft", "tpot", "qps", "throughput", "gpu_utilization", "error_rate"}
var anomalyMetricKeys = []string{"ttft", "tpot", "throughput", "gpu_utilization", "error_rate"}

const (
	defaultDeploymentName = "Qwen/Qwen3-32B"
	defaultModelName      = "Qwen/Qwen3-32B"
	defaultHardwareName   = "NVIDIA H800_SXM"
)

type deploymentInfo struct {
	DeploymentName string `json:"deploymentName"`
	ModelName      string `json:"modelName"`
	HardwareName   string `json:"hardware_name"`
}

var configuredDeploymentInfo = deploymentInfo{
	DeploymentName: defaultDeploymentName,
	ModelName:      defaultModelName,
	HardwareName:   defaultHardwareName,
}

var vllmLabels = map[string]string{
	"container":        "main",
	"dynamo_component": "backend",
	"dynamo_endpoint":  "generate",
	"dynamo_namespace": "dynamo-system-minimax-m25-tp8ep-gemmpath",
	"endpoint":         "system",
	"engine":           "0",
	"instance":         "10.244.236.95:9090",
	"job":              "dynamo-system/dynamo-worker",
	"namespace":        "dynamo-system",
	"pod":              "fake-llm-deployment-0",
}

type fakeDeployment struct {
	ModelName  string
	EngineType string
	BaseLabels map[string]string
}

var deploymentTemplates = []fakeDeployment{
	{
		ModelName:  defaultDeploymentName,
		EngineType: "vllm",
		BaseLabels: vllmLabels,
	},
	{
		ModelName:  "MiniMax-M2.1",
		EngineType: "sglang",
		BaseLabels: map[string]string{},
	},
	{
		ModelName:  "Qwen3-32B",
		EngineType: "other",
		BaseLabels: map[string]string{},
	},
	{
		ModelName:  "DeepSeek-R1-32B",
		EngineType: "vllm",
		BaseLabels: map[string]string{},
	},
}

func deploymentForIndex(index int) fakeDeployment {
	template := deploymentTemplates[index%len(deploymentTemplates)]
	if index == 0 {
		template.ModelName = configuredDeploymentInfo.DeploymentName
	}
	deployment := fakeDeployment{
		ModelName:  template.ModelName,
		EngineType: template.EngineType,
		BaseLabels: make(map[string]string, len(template.BaseLabels)),
	}
	for k, v := range template.BaseLabels {
		deployment.BaseLabels[k] = v
	}
	if index >= len(deploymentTemplates) {
		suffix := fmt.Sprintf("-%d", index+1)
		deployment.ModelName += suffix
		if pod, ok := deployment.BaseLabels["pod"]; ok {
			deployment.BaseLabels["pod"] = pod + suffix
		}
	}
	return deployment
}

func labelsForDeployment(deployment fakeDeployment) map[string]string {
	out := make(map[string]string, len(deployment.BaseLabels)+5)
	for k, v := range deployment.BaseLabels {
		out[k] = v
	}
	out["model_name"] = deployment.ModelName
	if deployment.ModelName == configuredDeploymentInfo.DeploymentName {
		out["model"] = configuredDeploymentInfo.ModelName
		out["deployment_name"] = configuredDeploymentInfo.DeploymentName
		out["hardware_name"] = configuredDeploymentInfo.HardwareName
		out["hardwareName"] = configuredDeploymentInfo.HardwareName
	}
	out["engine_type"] = deployment.EngineType
	return out
}

func queryEngineType(query string) string {
	q := strings.ToLower(query)
	if strings.Contains(q, "vllm:") {
		return "vllm"
	}
	if strings.Contains(q, "sglang:") {
		return "sglang"
	}
	return ""
}

func deploymentIndexesForQuery(query string, deploymentCount int) []int {
	engineType := queryEngineType(query)
	modelName := queryModelNameMatcher(query)
	indexes := make([]int, 0, deploymentCount)
	for index := 0; index < deploymentCount; index++ {
		deployment := deploymentForIndex(index)
		if engineType == "" || deployment.EngineType == engineType {
			if modelName != "" && deployment.ModelName != modelName {
				continue
			}
			indexes = append(indexes, index)
		}
	}
	return indexes
}

func queryModelNameMatcher(query string) string {
	const marker = `model_name="`
	start := strings.Index(query, marker)
	if start < 0 {
		return ""
	}
	start += len(marker)
	end := strings.Index(query[start:], `"`)
	if end < 0 {
		return ""
	}
	return query[start : start+end]
}

func metricMeta(query, metricKey string, deploymentIndex int) (map[string]string, map[string]string) {
	deployment := deploymentForIndex(deploymentIndex)
	engine := queryEngineType(query)
	if engine == "" {
		engine = "sglang"
	}

	nameByEngine := map[string]string{}
	labels := map[string]string{}

	if engine == "vllm" {
		switch metricKey {
		case "ttft":
			nameByEngine["__name__"] = "vllm:time_to_first_token_seconds"
			for k, v := range labelsForDeployment(deployment) {
				labels[k] = v
			}
		case "tpot":
			nameByEngine["__name__"] = "vllm:request_time_per_output_token_seconds"
			for k, v := range labelsForDeployment(deployment) {
				labels[k] = v
			}
		case "qps", "throughput", "error_rate":
			return map[string]string{}, labelsForDeployment(deployment)
		case "gpu_utilization":
			nameByEngine["__name__"] = "vllm:kv_cache_usage_perc"
			for k, v := range labelsForDeployment(deployment) {
				labels[k] = v
			}
		}
		return nameByEngine, labels
	}

	for k, v := range labelsForDeployment(deployment) {
		labels[k] = v
	}
	if metricKey == "ttft" {
		labels["le"] = "0.5"
	}
	if metricKey == "tpot" {
		labels["le"] = "0.1"
	}
	nameByEngine["__name__"] = metricProfiles[metricKey].MetricName
	return nameByEngine, labels
}

const (
	scrapeInterval = 15 * time.Second
	historyWindow  = 24 * time.Hour
	maxHistory     = int(historyWindow / scrapeInterval)
)

type point struct {
	TS  float64
	Val float64
}

type metricsStore struct {
	startTime       float64
	seed            int64
	normalSpread    float64
	anomalySpread   float64
	virtualNow      float64
	lastGenerated   float64
	remediated      bool
	forceAnomaly    bool
	anomalyMetrics  []string
	lastAction      string
	lastActionAt    float64
	lastRecoveredAt float64
	data            map[string][]point
	mu              sync.Mutex
}

func newMetricsStore(cycleMinutes int, normalSpread float64, anomalySpread float64, forceQueryShock bool) *metricsStore {
	_ = cycleMinutes
	_ = forceQueryShock
	now := alignToInterval(float64(time.Now().Unix()))
	s := &metricsStore{
		startTime:     now,
		seed:          time.Now().UnixNano(),
		normalSpread:  normalSpread,
		anomalySpread: anomalySpread,
		virtualNow:    now,
		lastGenerated: now - historyWindow.Seconds(),
		data:          make(map[string][]point),
	}
	for _, k := range metricKeys {
		s.data[k] = make([]point, 0, maxHistory)
	}
	s.generateUpTo(now)
	return s
}

func seededRand(metricKey string, bucket int64) *rand.Rand {
	h := int64(1469598103934665603)
	for _, c := range []byte(metricKey) {
		h ^= int64(c)
		h *= 1099511628211
	}
	h ^= bucket
	h *= 1099511628211
	if h < 0 {
		h = -h
	}
	return rand.New(rand.NewSource(h))
}

func (s *metricsStore) generateValue(metricKey string, ts float64) float64 {
	p := metricProfiles[metricKey]
	base := p.Good
	spread := s.normalSpread
	if s.forceAnomaly && s.isAnomalyMetricLocked(metricKey) {
		base = p.Bad
		spread = s.anomalySpread
	}
	if p.VeryBad == 0 && base == 0 {
		return 0
	}
	bucket := int64(ts) / int64(scrapeInterval.Seconds())
	r := seededRand(metricKey, bucket)
	jitter := base * p.Jitter * (r.Float64()*2 - 1)
	drift := base * spread * (r.Float64()*2 - 1)
	value := base + jitter + drift
	if value < 0 {
		return 0
	}
	if metricKey == "gpu_utilization" && value > 1 {
		return 1
	}
	return value
}

func (s *metricsStore) isAnomalyMetricLocked(metricKey string) bool {
	for _, selected := range s.anomalyMetrics {
		if selected == metricKey {
			return true
		}
	}
	return false
}

func (s *metricsStore) pickAnomalyMetricsLocked() []string {
	bucket := int64(s.virtualNow) + s.seed
	r := seededRand("anomaly-metric-selection", bucket)
	count := 1 + r.Intn(2)
	// Always include ttft as the first anomaly metric. Pick the
	// remaining count-1 randomly from the other anomaly metric keys.
	selected := []string{"ttft"}
	available := make([]string, 0, len(anomalyMetricKeys)-1)
	for _, k := range anomalyMetricKeys {
		if k != "ttft" {
			available = append(available, k)
		}
	}
	for len(selected) < count && len(available) > 0 {
		idx := r.Intn(len(available))
		selected = append(selected, available[idx])
		available = append(available[:idx], available[idx+1:]...)
	}
	return selected
}

func alignToInterval(ts float64) float64 {
	iv := scrapeInterval.Seconds()
	return math.Floor(ts/iv) * iv
}

func (s *metricsStore) generateUpTo(target float64) {
	t := alignToInterval(s.lastGenerated + scrapeInterval.Seconds())
	for t <= target {
		for _, key := range metricKeys {
			v := s.generateValue(key, t)
			s.data[key] = append(s.data[key], point{TS: t, Val: v})
		}
		t += scrapeInterval.Seconds()
	}
	s.lastGenerated = target
	for key, points := range s.data {
		if len(points) > maxHistory {
			s.data[key] = points[len(points)-maxHistory:]
		}
	}
}

func (s *metricsStore) trimHistoryLocked() {
	for key, points := range s.data {
		if len(points) > maxHistory {
			s.data[key] = points[len(points)-maxHistory:]
		}
	}
}

func (s *metricsStore) backfillRecentWindowLocked() {
	start := alignToInterval(s.virtualNow - 5*60)
	for t := start; t <= s.virtualNow; t += scrapeInterval.Seconds() {
		for _, key := range metricKeys {
			v := s.generateValue(key, t)
			s.data[key] = append(s.data[key], point{TS: t, Val: v})
		}
	}
	s.lastGenerated = s.virtualNow
	s.trimHistoryLocked()
}

func (s *metricsStore) scrape() {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := alignToInterval(float64(time.Now().Unix()))
	if now > s.virtualNow {
		s.virtualNow = now
	}
	s.generateUpTo(s.virtualNow)
}

func (s *metricsStore) advanceWindow(seconds float64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.virtualNow = alignToInterval(s.virtualNow + seconds)
	s.generateUpTo(s.virtualNow)
}

func (s *metricsStore) currentVirtualNow() float64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.virtualNow
}

func (s *metricsStore) getInstant(metricKey string) *point {
	s.scrape()
	s.mu.Lock()
	defer s.mu.Unlock()
	pts := s.data[metricKey]
	if len(pts) == 0 {
		return nil
	}
	p := pts[len(pts)-1]
	return &p
}

func (s *metricsStore) getRange(metricKey string, start, end float64, step int) [][2]any {
	s.scrape()
	s.mu.Lock()
	defer s.mu.Unlock()
	pts := s.data[metricKey]
	if len(pts) == 0 {
		return [][2]any{}
	}
	pointMap := make(map[int64]float64, len(pts))
	for _, p := range pts {
		k := int64(alignToInterval(p.TS))
		pointMap[k] = p.Val
	}
	res := make([][2]any, 0)
	for t := math.Floor(start); t <= end; t += float64(step) {
		k := int64(alignToInterval(t))
		v, ok := pointMap[k]
		if !ok {
			continue
		}
		res = append(res, [2]any{t, fmt.Sprintf("%.6f", v)})
	}
	return res
}

func (s *metricsStore) currentPhase() string {
	s.mu.Lock()
	forceAnomaly := s.forceAnomaly
	s.mu.Unlock()
	if forceAnomaly {
		return "ANOMALY"
	}
	return "NORMAL"
}

func (s *metricsStore) nextAnomalyInSeconds() float64 {
	s.mu.Lock()
	forceAnomaly := s.forceAnomaly
	s.mu.Unlock()
	if forceAnomaly {
		return 0
	}
	return -1
}

func (s *metricsStore) applyAction(action string) map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.remediated = false
	s.forceAnomaly = false
	s.anomalyMetrics = nil
	s.lastAction = action
	s.lastActionAt = s.virtualNow
	s.backfillRecentWindowLocked()
	return s.stateLocked()
}

func (s *metricsStore) setNormalMode() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.remediated = false
	s.forceAnomaly = false
	s.anomalyMetrics = nil
	s.backfillRecentWindowLocked()
	return s.stateLocked()
}

func (s *metricsStore) setAnomalyMode() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.remediated = false
	s.forceAnomaly = true
	s.anomalyMetrics = s.pickAnomalyMetricsLocked()
	s.lastRecoveredAt = s.virtualNow
	s.backfillRecentWindowLocked()
	return s.stateLocked()
}

func (s *metricsStore) stateLocked() map[string]any {
	nextAnomaly := any(nil)
	if s.forceAnomaly {
		nextAnomaly = float64(0)
	}
	phase := "NORMAL"
	if s.forceAnomaly {
		phase = "ANOMALY"
	}
	return map[string]any{
		"phase":                   phase,
		"remediated":              s.remediated,
		"force_anomaly":           s.forceAnomaly,
		"anomaly_metrics":         append([]string(nil), s.anomalyMetrics...),
		"last_action":             s.lastAction,
		"last_action_at":          s.lastActionAt,
		"last_recovered_at":       s.lastRecoveredAt,
		"next_anomaly_in_seconds": nextAnomaly,
		"scrape_interval_seconds": scrapeInterval.Seconds(),
		"history_seconds":         historyWindow.Seconds(),
		"max_points_per_metric":   maxHistory,
		"virtual_now":             s.virtualNow,
	}
}

func identifyMetric(query string) string {
	q := strings.ToLower(strings.TrimSpace(query))
	switch {
	case strings.Contains(q, "time_to_first_token"):
		return "ttft"
	case strings.Contains(q, "inter_token_latency"), strings.Contains(q, "output_token"):
		return "tpot"
	case strings.Contains(q, "request_success_total") && strings.Contains(q, "finished_reason=\"error\""):
		return "error_rate"
	case strings.Contains(q, "aborted"), (strings.Contains(q, "error") && strings.Contains(q, "rate")):
		return "error_rate"
	case strings.Contains(q, "request_success_total"):
		return "qps"
	case strings.Contains(q, "num_requests"):
		return "qps"
	case strings.Contains(q, "generation_tokens"):
		return "throughput"
	case strings.Contains(q, "token_usage"), strings.Contains(q, "kv_cache"):
		return "gpu_utilization"
	case strings.Contains(q, "gpu_info"):
		return "_gpu_info"
	case q == "up":
		return "_up"
	default:
		return ""
	}
}

func parsePrometheusTime(raw string) (float64, error) {
	if raw == "" {
		return 0, fmt.Errorf("empty time")
	}
	if parsed, err := strconv.ParseFloat(raw, 64); err == nil {
		return parsed, nil
	}
	parsed, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		return 0, err
	}
	return float64(parsed.Unix()), nil
}

func queryProducesSingleSeries(metricKey string) bool {
	switch metricKey {
	case "qps", "throughput", "error_rate":
		return true
	default:
		return false
	}
}

func deploymentInfoForIndex(index int) deploymentInfo {
	deployment := deploymentForIndex(index)
	info := configuredDeploymentInfo
	info.DeploymentName = deployment.ModelName
	if deployment.ModelName != configuredDeploymentInfo.DeploymentName {
		info.ModelName = deployment.ModelName
	}
	return info
}

func gpuInfoMetric(index int) map[string]string {
	info := deploymentInfoForIndex(index)
	labels := labelsForDeployment(deploymentForIndex(index))
	labels["__name__"] = "vllm:gpu_info"
	labels["model_name"] = info.DeploymentName
	labels["deployment_name"] = info.DeploymentName
	labels["model"] = info.ModelName
	labels["hardware_name"] = info.HardwareName
	labels["hardwareName"] = info.HardwareName
	labels["gpu_type"] = info.HardwareName
	labels["gpuType"] = info.HardwareName
	return labels
}

func metricIdentity(query, metricKey string, deploymentIndex int) map[string]string {
	deployment := deploymentForIndex(deploymentIndex)
	engine := queryEngineType(query)
	if engine == "" {
		engine = deployment.EngineType
	}

	if queryProducesSingleSeries(metricKey) {
		return map[string]string{}
	}

	labels := labelsForDeployment(deployment)
	if metricKey == "gpu_utilization" {
		if engine == "vllm" {
			labels["__name__"] = "vllm:kv_cache_usage_perc"
		} else {
			labels["__name__"] = metricProfiles[metricKey].MetricName
		}
	}
	if engine != "vllm" {
		switch metricKey {
		case "ttft":
			labels["le"] = "0.5"
		case "tpot":
			labels["le"] = "0.1"
		}
	}
	return labels
}

type promResponse struct {
	Status string `json:"status"`
	Data   any    `json:"data"`
}

type fakePromServer struct {
	store                *metricsStore
	deploymentCount      int
	rangeMu              sync.Mutex
	lastQueryCycleEndSec int64
	hasSeenFirstCycle    bool
}

type fakeActionRequest struct {
	Action         string `json:"action"`
	TaskType       string `json:"taskType"`
	DeploymentName string `json:"deploymentName"`
}

type fakeModeRequest struct {
	Mode string `json:"mode"`
}

func (s *fakePromServer) ensureAdvancedOncePerCycle(endSec float64) {
	_ = endSec
}

func (s *fakePromServer) sendJSON(w http.ResponseWriter, code int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	if err := json.NewEncoder(w).Encode(data); err != nil {
		log.Printf("failed to write json: %v", err)
	}
}

// sendJSONLogged encodes data, writes it to the client, and prints a copy to stdout.
func (s *fakePromServer) sendJSONLogged(w http.ResponseWriter, code int, data any, label string) {
	body, err := json.Marshal(data)
	if err != nil {
		log.Printf("failed to marshal json: %v", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	if _, err = w.Write(body); err != nil {
		log.Printf("failed to write json: %v", err)
	}
	fmt.Printf("[pimclaw_query_metrics response] %s phase=%s\n%s\n", label, s.store.currentPhase(), string(body))
}

func (s *fakePromServer) handleStatus(w http.ResponseWriter, _ *http.Request) {
	virtualNow := s.store.currentVirtualNow()
	nextAnomaly := any(math.Round(s.store.nextAnomalyInSeconds()*10) / 10)
	if s.store.nextAnomalyInSeconds() < 0 {
		nextAnomaly = nil
	}
	info := map[string]any{
		"phase":                   s.store.currentPhase(),
		"next_anomaly_in_seconds": nextAnomaly,
		"uptime_seconds":          math.Round((virtualNow-s.store.startTime)*10) / 10,
		"virtual_now":             virtualNow,
		"scrape_interval_seconds": scrapeInterval.Seconds(),
		"history_seconds":         historyWindow.Seconds(),
		"max_points_per_metric":   maxHistory,
		"metrics":                 []string{"ttft", "tpot", "qps", "throughput", "gpu_utilization", "error_rate"},
		"deployment_info":         configuredDeploymentInfo,
	}
	s.store.mu.Lock()
	info["remediated"] = s.store.remediated
	info["force_anomaly"] = s.store.forceAnomaly
	info["anomaly_metrics"] = append([]string(nil), s.store.anomalyMetrics...)
	info["last_action"] = s.store.lastAction
	info["last_action_at"] = s.store.lastActionAt
	info["last_recovered_at"] = s.store.lastRecoveredAt
	points := make(map[string]int)
	for k, v := range s.store.data {
		points[k] = len(v)
	}
	s.store.mu.Unlock()
	info["data_points_per_metric"] = points
	s.sendJSON(w, http.StatusOK, info)
}

func normalizeAction(action string) (string, bool) {
	action = strings.ToLower(strings.TrimSpace(action))
	action = strings.ReplaceAll(action, "_", "-")
	switch action {
	case "restart":
		return "restart", true
	case "reconfig", "reconfigure":
		return "reconfigure", true
	case "scale-in", "scale-down":
		return "scale-in", true
	case "scale-out", "scale-up":
		return "scale-out", true
	default:
		return action, false
	}
}

func envOrDefault(name string, fallback string) string {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	return value
}

func (s *fakePromServer) handleFakeAction(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		s.sendJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "use POST"})
		return
	}

	req := fakeActionRequest{
		Action:         r.URL.Query().Get("action"),
		TaskType:       r.URL.Query().Get("taskType"),
		DeploymentName: r.URL.Query().Get("deploymentName"),
	}
	if r.Body != nil {
		defer r.Body.Close()
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil && err.Error() != "EOF" {
			s.sendJSON(w, http.StatusBadRequest, map[string]any{"error": fmt.Sprintf("invalid JSON body: %v", err)})
			return
		}
	}

	rawAction := req.Action
	if strings.TrimSpace(rawAction) == "" {
		rawAction = req.TaskType
	}
	action, ok := normalizeAction(rawAction)
	if !ok {
		s.sendJSON(w, http.StatusBadRequest, map[string]any{
			"error":            "unsupported action",
			"supportedActions": []string{"restart", "reconfig", "reconfigure", "scale-in", "scale-out", "scale-up", "scale-down"},
		})
		return
	}

	state := s.store.applyAction(action)
	state["ok"] = true
	state["accepted_action"] = action
	state["deploymentName"] = req.DeploymentName
	s.sendJSON(w, http.StatusOK, state)
}

func (s *fakePromServer) handleMode(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		s.sendJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "use POST"})
		return
	}

	req := fakeModeRequest{Mode: r.URL.Query().Get("mode")}
	if r.Body != nil {
		defer r.Body.Close()
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil && err.Error() != "EOF" {
			s.sendJSON(w, http.StatusBadRequest, map[string]any{"error": fmt.Sprintf("invalid JSON body: %v", err)})
			return
		}
	}

	switch strings.ToLower(strings.TrimSpace(req.Mode)) {
	case "normal", "good", "healthy":
		state := s.store.setNormalMode()
		state["ok"] = true
		state["message"] = "fake metrics switched to normal mode"
		s.sendJSON(w, http.StatusOK, state)
	case "anomaly", "bad", "unhealthy":
		state := s.store.setAnomalyMode()
		state["ok"] = true
		state["message"] = "fake metrics switched to anomaly mode"
		s.sendJSON(w, http.StatusOK, state)
	default:
		s.sendJSON(w, http.StatusBadRequest, map[string]any{
			"error":          "unsupported mode",
			"supportedModes": []string{"normal", "anomaly"},
		})
	}
}

func (s *fakePromServer) handleInstantQuery(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query().Get("query")
	metricKey := identifyMetric(query)

	if metricKey == "_up" {
		s.sendJSON(w, http.StatusOK, promResponse{
			Status: "success",
			Data: map[string]any{
				"resultType": "vector",
				"result": []map[string]any{{
					"metric": map[string]string{"__name__": "up", "job": "sglang"},
					"value":  []any{float64(time.Now().Unix()), "1"},
				}},
			},
		})
		return
	}
	if metricKey == "_gpu_info" {
		deploymentIndexes := deploymentIndexesForQuery(query, s.deploymentCount)
		result := make([]map[string]any, 0, len(deploymentIndexes))
		for _, i := range deploymentIndexes {
			result = append(result, map[string]any{
				"metric": gpuInfoMetric(i),
				"value":  []any{float64(time.Now().Unix()), "1"},
			})
		}
		s.sendJSON(w, http.StatusOK, promResponse{
			Status: "success",
			Data: map[string]any{
				"resultType": "vector",
				"result":     result,
			},
		})
		return
	}
	if metricKey == "" || metricProfiles[metricKey].MetricName == "" {
		s.sendJSON(w, http.StatusOK, promResponse{Status: "success", Data: map[string]any{"resultType": "vector", "result": []any{}}})
		return
	}

	pt := s.store.getInstant(metricKey)
	if pt == nil {
		s.sendJSON(w, http.StatusOK, promResponse{Status: "success", Data: map[string]any{"resultType": "vector", "result": []any{}}})
		return
	}
	deploymentIndexes := deploymentIndexesForQuery(query, s.deploymentCount)
	if len(deploymentIndexes) == 0 {
		s.sendJSON(w, http.StatusOK, promResponse{Status: "success", Data: map[string]any{"resultType": "vector", "result": []any{}}})
		return
	}
	result := make([]map[string]any, 0, len(deploymentIndexes))
	if queryProducesSingleSeries(metricKey) {
		result = append(result, map[string]any{
			"metric": map[string]string{},
			"value":  []any{pt.TS, fmt.Sprintf("%.6f", pt.Val)},
		})
	} else {
		for _, i := range deploymentIndexes {
			result = append(result, map[string]any{
				"metric": metricIdentity(query, metricKey, i),
				"value":  []any{pt.TS, fmt.Sprintf("%.6f", pt.Val)},
			})
		}
	}
	s.sendJSON(w, http.StatusOK, promResponse{
		Status: "success",
		Data: map[string]any{
			"resultType": "vector",
			"result":     result,
		},
	})
}

func (s *fakePromServer) handleRangeQuery(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	query := q.Get("query")
	metricKey := identifyMetric(query)
	if metricKey == "" || metricProfiles[metricKey].MetricName == "" {
		s.sendJSON(w, http.StatusOK, promResponse{Status: "success", Data: map[string]any{"resultType": "matrix", "result": []any{}}})
		return
	}

	now := s.store.currentVirtualNow()
	start := now - 300
	end := now
	step := 15

	if v := q.Get("start"); v != "" {
		if p, err := parsePrometheusTime(v); err == nil {
			start = p
		}
	}
	if v := q.Get("end"); v != "" {
		if p, err := parsePrometheusTime(v); err == nil {
			end = p
		}
	}
	if v := q.Get("step"); v != "" {
		if p, err := strconv.Atoi(v); err == nil && p > 0 {
			step = p
		}
	}

	// PimClaw calls query_range once per metric in a cycle with the same end timestamp.
	// Advance one synthetic 5-minute window once per cycle to make current-vs-previous meaningful.
	s.ensureAdvancedOncePerCycle(end)

	values := s.store.getRange(metricKey, start, end, step)
	deploymentIndexes := deploymentIndexesForQuery(query, s.deploymentCount)
	if len(deploymentIndexes) == 0 {
		s.sendJSONLogged(w, http.StatusOK, promResponse{
			Status: "success",
			Data: map[string]any{
				"resultType": "matrix",
				"result":     []any{},
			},
		}, metricKey)
		return
	}
	result := make([]map[string]any, 0, len(deploymentIndexes))
	if queryProducesSingleSeries(metricKey) {
		result = append(result, map[string]any{
			"metric": map[string]string{},
			"values": values,
		})
	} else {
		for _, i := range deploymentIndexes {
			result = append(result, map[string]any{
				"metric": metricIdentity(query, metricKey, i),
				"values": values,
			})
		}
	}
	s.sendJSONLogged(w, http.StatusOK, promResponse{
		Status: "success",
		Data: map[string]any{
			"resultType": "matrix",
			"result":     result,
		},
	}, metricKey)
}

func (s *fakePromServer) rootFallback(w http.ResponseWriter, _ *http.Request) {
	s.sendJSON(w, http.StatusOK, promResponse{
		Status: "success",
		Data:   map[string]any{"resultType": "vector", "result": []any{}},
	})
}

func (s *fakePromServer) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/query", s.handleInstantQuery)
	mux.HandleFunc("/api/v1/query_range", s.handleRangeQuery)
	mux.HandleFunc("/-/healthy", func(w http.ResponseWriter, _ *http.Request) {
		s.sendJSON(w, http.StatusOK, "Prometheus is Fake but Healthy")
	})
	mux.HandleFunc("/-/ready", func(w http.ResponseWriter, _ *http.Request) {
		s.sendJSON(w, http.StatusOK, "Prometheus is Fake but Healthy")
	})
	mux.HandleFunc("/api/v1/status/config", func(w http.ResponseWriter, _ *http.Request) {
		s.sendJSON(w, http.StatusOK, promResponse{Status: "success", Data: map[string]any{"yaml": "fake"}})
	})
	mux.HandleFunc("/_fake/status", s.handleStatus)
	mux.HandleFunc("/_fake/action", s.handleFakeAction)
	mux.HandleFunc("/_fake/actions", s.handleFakeAction)
	mux.HandleFunc("/_fake/mode", s.handleMode)
	mux.HandleFunc("/", s.rootFallback)

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.Printf("[%s] %s %s", s.store.currentPhase(), r.Method, r.URL.Path)
		mux.ServeHTTP(w, r)
	})
}

func main() {
	defaultPort := 9090
	if p := os.Getenv("PORT"); p != "" {
		if parsed, err := strconv.Atoi(p); err == nil && parsed > 0 {
			defaultPort = parsed
		}
	}
	port := flag.Int("port", defaultPort, "Listen port")
	cycleMinutes := flag.Int("cycle-minutes", 5, "Deprecated; retained for CLI compatibility")
	flag.Parse()

	configuredDeploymentInfo = deploymentInfo{
		DeploymentName: envOrDefault("FAKE_DEPLOYMENT_NAME", defaultDeploymentName),
		ModelName:      envOrDefault("FAKE_MODEL_NAME", defaultModelName),
		HardwareName:   envOrDefault("FAKE_HARDWARE_NAME", defaultHardwareName),
	}

	deploymentCount := 2
	if raw := strings.TrimSpace(os.Getenv("FAKE_DEPLOYMENT_COUNT")); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			deploymentCount = parsed
		} else {
			log.Printf("invalid FAKE_DEPLOYMENT_COUNT=%q, using default %d", raw, deploymentCount)
		}
	}

	normalSpread := 0.04
	if raw := strings.TrimSpace(os.Getenv("FAKE_NORMAL_RANDOMNESS")); raw != "" {
		if parsed, err := strconv.ParseFloat(raw, 64); err == nil && parsed >= 0 {
			normalSpread = parsed
		} else {
			log.Printf("invalid FAKE_NORMAL_RANDOMNESS=%q, using default %.2f", raw, normalSpread)
		}
	}

	anomalySpread := 0.35
	if raw := strings.TrimSpace(os.Getenv("FAKE_ANOMALY_RANDOMNESS")); raw != "" {
		if parsed, err := strconv.ParseFloat(raw, 64); err == nil && parsed >= 0 {
			anomalySpread = parsed
		} else {
			log.Printf("invalid FAKE_ANOMALY_RANDOMNESS=%q, using default %.2f", raw, anomalySpread)
		}
	}

	forceQueryShock := false
	if raw := strings.TrimSpace(os.Getenv("FAKE_FORCE_ANOMALY_EVERY_QUERY")); raw != "" {
		forceQueryShock = strings.EqualFold(raw, "1") || strings.EqualFold(raw, "true") || strings.EqualFold(raw, "yes") || strings.EqualFold(raw, "on")
	}

	store := newMetricsStore(*cycleMinutes, normalSpread, anomalySpread, forceQueryShock)
	server := &fakePromServer{store: store, deploymentCount: deploymentCount}

	nextAnomaly := store.nextAnomalyInSeconds()
	pts := len(store.data["ttft"])
	go func() {
		ticker := time.NewTicker(scrapeInterval)
		defer ticker.Stop()
		for range ticker.C {
			store.scrape()
		}
	}()

	fmt.Printf("Fake Prometheus listening on port %d\n", *port)
	fmt.Printf("Mode: starts in NORMAL; POST /_fake/mode switches normal/anomaly\n")
	fmt.Printf("Current phase: %s\n", store.currentPhase())
	if nextAnomaly >= 0 {
		fmt.Printf("Next anomaly in: %.0fs (%.1fmin)\n", nextAnomaly, nextAnomaly/60)
	}
	fmt.Printf("Scrape interval: %.0fs\n", scrapeInterval.Seconds())
	fmt.Printf("Pre-filled: %d data points per metric (24h rolling history)\n", pts)
	fmt.Printf("Normal randomness spread: +/-%.2f around the normal baseline (set FAKE_NORMAL_RANDOMNESS)\n", normalSpread)
	fmt.Printf("Anomaly randomness spread: +/-%.2f around the anomaly baseline (set FAKE_ANOMALY_RANDOMNESS)\n", anomalySpread)
	fmt.Printf("Force anomaly every query: %t (deprecated; mode APIs now control anomaly state)\n", forceQueryShock)
	fmt.Printf("Deployment: %s | model: %s | hardware: %s\n", configuredDeploymentInfo.DeploymentName, configuredDeploymentInfo.ModelName, configuredDeploymentInfo.HardwareName)
	fmt.Printf("Status: http://localhost:%d/_fake/status\n\n", *port)
	fmt.Printf("Deployment series per metric: %d (set FAKE_DEPLOYMENT_COUNT to change)\n\n", deploymentCount)

	addr := fmt.Sprintf(":%d", *port)
	if err := http.ListenAndServe(addr, server.handler()); err != nil {
		log.Fatal(err)
	}
}
