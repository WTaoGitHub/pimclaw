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
	Bases      []float64
	Jitter     float64
	MetricName string
}

var metricProfiles = map[string]metricProfile{
	"ttft": {
		Bases:      []float64{0.15, 0.13, 0.45},
		Jitter:     0.08,
		MetricName: "sglang:time_to_first_token_seconds",
	},
	"tpot": {
		Bases:      []float64{0.020, 0.022, 0.055},
		Jitter:     0.05,
		MetricName: "sglang:inter_token_latency_seconds",
	},
	"qps": {
		Bases:      []float64{12.0, 13.5, 5.5},
		Jitter:     0.10,
		MetricName: "sglang:num_requests_total",
	},
	"throughput": {
		Bases:      []float64{480, 510, 280},
		Jitter:     0.08,
		MetricName: "sglang:generation_tokens_total",
	},
	"gpu_utilization": {
		Bases:      []float64{0.65, 0.70, 0.97},
		Jitter:     0.05,
		MetricName: "sglang:token_usage",
	},
	"error_rate": {
		Bases:      []float64{0.005, 0.003, 0.08},
		Jitter:     0.15,
		MetricName: "sglang:num_aborted_requests_total",
	},
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
	"model":            "/nfs/models/MiniMax/MiniMax-M2.5",
	"model_name":       "minimax-m25-tp8ep",
	"namespace":        "dynamo-system",
	"pod":              "minimax-m25-tp8ep-gemmpath-0-vllmworker-mgjgs",
}

type fakeDeployment struct {
	ModelName  string
	EngineType string
	BaseLabels map[string]string
}

var deploymentTemplates = []fakeDeployment{
	{
		ModelName:  "minimax-m25-tp8ep",
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
	out := make(map[string]string, len(deployment.BaseLabels)+2)
	for k, v := range deployment.BaseLabels {
		out[k] = v
	}
	out["model_name"] = deployment.ModelName
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
	indexes := make([]int, 0, deploymentCount)
	for index := 0; index < deploymentCount; index++ {
		deployment := deploymentForIndex(index)
		if engineType == "" || deployment.EngineType == engineType {
			indexes = append(indexes, index)
		}
	}
	return indexes
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
	maxHistory     = 3600
)

type point struct {
	TS  float64
	Val float64
}

type metricsStore struct {
	cycleMinutes     int
	cycleSeconds     float64
	fullCycleSeconds float64
	startTime        float64
	seed             int64
	normalSpread     float64
	anomalySpread    float64
	forceQueryShock  bool
	virtualNow       float64
	lastGenerated    float64
	remediated       bool
	forceAnomaly     bool
	lastAction       string
	lastActionAt     float64
	lastRecoveredAt  float64
	data             map[string][]point
	mu               sync.Mutex
}

func newMetricsStore(cycleMinutes int, normalSpread float64, anomalySpread float64, forceQueryShock bool) *metricsStore {
	now := float64(time.Now().Unix())
	s := &metricsStore{
		cycleMinutes:     cycleMinutes,
		cycleSeconds:     float64(cycleMinutes * 60),
		fullCycleSeconds: float64(cycleMinutes * 60 * 3),
		startTime:        now,
		seed:             time.Now().UnixNano(),
		normalSpread:     normalSpread,
		anomalySpread:    anomalySpread,
		forceQueryShock:  forceQueryShock,
		virtualNow:       now,
		lastGenerated:    now - 600,
		data:             make(map[string][]point),
	}
	for k := range metricProfiles {
		s.data[k] = make([]point, 0, maxHistory)
	}
	s.generateUpTo(now)
	return s
}

func (s *metricsStore) cycleIndex(ts float64) int {
	elapsed := ts - s.startTime
	pos := math.Mod(elapsed, s.fullCycleSeconds)
	if pos < 0 {
		pos += s.fullCycleSeconds
	}
	idx := int(pos / s.cycleSeconds)
	if idx > 2 {
		return 2
	}
	if idx < 0 {
		return 0
	}
	return idx
}

func (s *metricsStore) effectiveCycleIndex(ts float64) int {
	idx := s.cycleIndex(ts)
	if s.forceAnomaly {
		return 2
	}
	if s.remediated && idx == 2 {
		return 1
	}
	return idx
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

func (s *metricsStore) cycleNumber(ts float64) int64 {
	elapsed := ts - s.startTime
	if elapsed < 0 {
		return 0
	}
	return int64(elapsed / s.cycleSeconds)
}

func (s *metricsStore) cycleFactor(metricKey string, ts float64, cycleIndex int) float64 {
	cycleNumber := s.cycleNumber(ts)
	bucket := cycleNumber + int64(cycleIndex)*1_000_003 + s.seed
	r := seededRand(metricKey, bucket)
	if cycleIndex == 2 {
		return 1 + ((r.Float64()*2)-1)*s.anomalySpread
	}
	return 1 + ((r.Float64()*2)-1)*s.normalSpread
}

func (s *metricsStore) shockFactor(metricKey string, ts float64, shockHigh bool) float64 {
	bucket := int64(alignToInterval(ts)) + s.seed
	r := seededRand(metricKey, bucket)
	switch metricKey {
	case "qps", "throughput":
		if shockHigh {
			return 3.0 + r.Float64()*0.9
		}
		return 0.04 + r.Float64()*0.06
	case "gpu_utilization":
		if shockHigh {
			return 1.8 + r.Float64()*0.4
		}
		return 0.05 + r.Float64()*0.05
	default:
		if shockHigh {
			return 3.2 + r.Float64()*0.8
		}
		return 0.12 + r.Float64()*0.08
	}
}

func (s *metricsStore) generateValue(metricKey string, ts float64) float64 {
	p := metricProfiles[metricKey]
	idx := s.effectiveCycleIndex(ts)
	base := p.Bases[idx] * s.cycleFactor(metricKey, ts, idx)
	bucket := int64(ts) / int64(scrapeInterval.Seconds())
	r := seededRand(metricKey, bucket)
	jitter := base * p.Jitter * (r.Float64()*2 - 1)
	return base + jitter
}

func alignToInterval(ts float64) float64 {
	iv := scrapeInterval.Seconds()
	return math.Floor(ts/iv) * iv
}

func (s *metricsStore) generateUpTo(target float64) {
	t := alignToInterval(s.lastGenerated + scrapeInterval.Seconds())
	for t <= target {
		for key := range metricProfiles {
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

func (s *metricsStore) resetHistoryLocked() {
	for k := range metricProfiles {
		s.data[k] = make([]point, 0, maxHistory)
	}
	s.lastGenerated = s.virtualNow - 600
	s.generateUpTo(s.virtualNow)
}

func (s *metricsStore) scrape() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.generateUpTo(s.virtualNow)
}

func (s *metricsStore) advanceWindow(seconds float64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.virtualNow += seconds
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
	if s.forceQueryShock && !s.remediated && !s.forceAnomaly {
		shockHigh := s.cycleNumber(s.virtualNow)%2 == 0
		value := s.generateValue(metricKey, s.virtualNow)
		profileBase := metricProfiles[metricKey].Bases[s.cycleIndex(s.virtualNow)]
		value = profileBase * s.shockFactor(metricKey, s.virtualNow, shockHigh)
		return &point{TS: alignToInterval(s.virtualNow), Val: value}
	}
	p := pts[len(pts)-1]
	return &p
}

func (s *metricsStore) getRange(metricKey string, start, end float64, step int) [][2]any {
	s.scrape()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.forceQueryShock && !s.forceAnomaly {
		if s.remediated {
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
					v = s.generateValue(metricKey, t)
				}
				res = append(res, [2]any{t, fmt.Sprintf("%.6f", v)})
			}
			return res
		}
		shockHigh := s.cycleNumber(s.virtualNow)%2 == 0
		res := make([][2]any, 0)
		for t := math.Floor(start); t <= end; t += float64(step) {
			profileBase := metricProfiles[metricKey].Bases[s.cycleIndex(s.virtualNow)]
			value := profileBase * s.shockFactor(metricKey, t, shockHigh)
			res = append(res, [2]any{t, fmt.Sprintf("%.6f", value)})
		}
		return res
	}
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
			v = s.generateValue(metricKey, t)
		}
		res = append(res, [2]any{t, fmt.Sprintf("%.6f", v)})
	}
	return res
}

func (s *metricsStore) currentPhase() string {
	s.mu.Lock()
	remediated := s.remediated
	forceAnomaly := s.forceAnomaly
	virtualNow := s.virtualNow
	s.mu.Unlock()
	if remediated {
		return "REMEDIATED-NORMAL"
	}
	if forceAnomaly {
		return "ANOMALY"
	}
	idx := s.cycleIndex(virtualNow)
	if idx == 2 {
		return "ANOMALY"
	}
	return fmt.Sprintf("NORMAL-%d", idx+1)
}

func (s *metricsStore) nextAnomalyInSeconds() float64 {
	now := s.currentVirtualNow()
	s.mu.Lock()
	remediated := s.remediated
	forceAnomaly := s.forceAnomaly
	s.mu.Unlock()
	if remediated {
		return -1
	}
	if forceAnomaly {
		return 0
	}
	elapsed := now - s.startTime
	pos := math.Mod(elapsed, s.fullCycleSeconds)
	if pos < 0 {
		pos += s.fullCycleSeconds
	}
	anomalyStart := s.cycleSeconds * 2
	if s.cycleIndex(now) == 2 {
		return 0
	}
	if pos < anomalyStart {
		return anomalyStart - pos
	}
	return s.fullCycleSeconds - pos + anomalyStart
}

func (s *metricsStore) applyAction(action string) map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.remediated = true
	s.forceAnomaly = false
	s.lastAction = action
	s.lastActionAt = s.virtualNow
	s.resetHistoryLocked()
	return s.stateLocked()
}

func (s *metricsStore) recoverAnomaly() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.remediated = false
	s.forceAnomaly = true
	s.lastRecoveredAt = s.virtualNow
	s.resetHistoryLocked()
	return s.stateLocked()
}

func (s *metricsStore) stateLocked() map[string]any {
	nextAnomaly := any(nil)
	if !s.remediated {
		if s.forceAnomaly {
			nextAnomaly = float64(0)
		} else {
			elapsed := s.virtualNow - s.startTime
			pos := math.Mod(elapsed, s.fullCycleSeconds)
			if pos < 0 {
				pos += s.fullCycleSeconds
			}
			anomalyStart := s.cycleSeconds * 2
			if s.cycleIndex(s.virtualNow) == 2 {
				nextAnomaly = float64(0)
			} else if pos < anomalyStart {
				nextAnomaly = math.Round((anomalyStart-pos)*10) / 10
			} else {
				nextAnomaly = math.Round((s.fullCycleSeconds-pos+anomalyStart)*10) / 10
			}
		}
	}
	phase := "REMEDIATED-NORMAL"
	if !s.remediated {
		if s.forceAnomaly {
			phase = "ANOMALY"
		} else {
			idx := s.cycleIndex(s.virtualNow)
			if idx == 2 {
				phase = "ANOMALY"
			} else {
				phase = fmt.Sprintf("NORMAL-%d", idx+1)
			}
		}
	}
	return map[string]any{
		"phase":                   phase,
		"remediated":              s.remediated,
		"force_anomaly":           s.forceAnomaly,
		"last_action":             s.lastAction,
		"last_action_at":          s.lastActionAt,
		"last_recovered_at":       s.lastRecoveredAt,
		"next_anomaly_in_seconds": nextAnomaly,
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

func (s *fakePromServer) ensureAdvancedOncePerCycle(endSec float64) {
	cycleEnd := int64(math.Floor(endSec))
	s.rangeMu.Lock()
	defer s.rangeMu.Unlock()
	if !s.hasSeenFirstCycle {
		s.lastQueryCycleEndSec = cycleEnd
		s.hasSeenFirstCycle = true
		return
	}
	if cycleEnd != s.lastQueryCycleEndSec {
		s.store.advanceWindow(s.store.cycleSeconds)
		s.lastQueryCycleEndSec = cycleEnd
	}
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
		"cycle_index":             s.store.cycleIndex(virtualNow),
		"next_anomaly_in_seconds": nextAnomaly,
		"cycle_minutes":           s.store.cycleMinutes,
		"full_cycle_minutes":      s.store.cycleMinutes * 3,
		"uptime_seconds":          math.Round((virtualNow-s.store.startTime)*10) / 10,
		"virtual_now":             virtualNow,
		"metrics":                 []string{"ttft", "tpot", "qps", "throughput", "gpu_utilization", "error_rate"},
	}
	s.store.mu.Lock()
	info["remediated"] = s.store.remediated
	info["force_anomaly"] = s.store.forceAnomaly
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

func (s *fakePromServer) handleRecoverAnomaly(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		s.sendJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "use POST"})
		return
	}
	state := s.store.recoverAnomaly()
	state["ok"] = true
	state["message"] = "fake metrics recovered to anomaly mode"
	s.sendJSON(w, http.StatusOK, state)
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
	mux.HandleFunc("/_fake/recover", s.handleRecoverAnomaly)
	mux.HandleFunc("/_fake/recover-anomaly", s.handleRecoverAnomaly)
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
	cycleMinutes := flag.Int("cycle-minutes", 5, "Minutes per cycle window")
	flag.Parse()

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

	fmt.Printf("Fake Prometheus listening on port %d\n", *port)
	fmt.Printf("Cycle: %dmin per window x 3 = %dmin full cycle\n", *cycleMinutes, *cycleMinutes*3)
	fmt.Println("Pattern: NORMAL-1 -> NORMAL-2 -> ANOMALY -> repeat")
	fmt.Printf("Current phase: %s\n", store.currentPhase())
	fmt.Printf("Next anomaly in: %.0fs (%.1fmin)\n", nextAnomaly, nextAnomaly/60)
	fmt.Printf("Pre-filled: %d data points per metric (10 min history)\n", pts)
	fmt.Printf("Normal randomness spread: +/-%.2f around the normal baseline (set FAKE_NORMAL_RANDOMNESS)\n", normalSpread)
	fmt.Printf("Anomaly randomness spread: +/-%.2f around the anomaly baseline (set FAKE_ANOMALY_RANDOMNESS)\n", anomalySpread)
	fmt.Printf("Force anomaly every query: %t (set FAKE_FORCE_ANOMALY_EVERY_QUERY)\n", forceQueryShock)
	fmt.Printf("Status: http://localhost:%d/_fake/status\n\n", *port)
	fmt.Printf("Deployment series per metric: %d (set FAKE_DEPLOYMENT_COUNT to change)\n\n", deploymentCount)

	addr := fmt.Sprintf(":%d", *port)
	if err := http.ListenAndServe(addr, server.handler()); err != nil {
		log.Fatal(err)
	}
}
