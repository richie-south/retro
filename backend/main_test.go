package main

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

func connectTest(t *testing.T, url, room string) (*websocket.Conn, message) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(url, "http")+"/api/socket", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.CloseNow() })
	if err = wsjson.Write(ctx, conn, message{Type: "join", Room: room}); err != nil {
		t.Fatal(err)
	}
	var m message
	if err = wsjson.Read(ctx, conn, &m); err != nil {
		t.Fatal(err)
	}
	return conn, m
}
func readType(t *testing.T, c *websocket.Conn, kind string) message {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	for {
		var m message
		if err := wsjson.Read(ctx, c, &m); err != nil {
			t.Fatal(err)
		}
		if m.Type == kind {
			return m
		}
	}
}
func sendTest(t *testing.T, c *websocket.Conn, m message) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := wsjson.Write(ctx, c, m); err != nil {
		t.Fatal(err)
	}
}
func TestSocketIsolationAndCleanup(t *testing.T) {
	s := newServer()
	httpServer := httptest.NewServer(s.handler(t.TempDir()))
	defer httpServer.Close()
	room := strings.Repeat("a", 32)
	a, first := connectTest(t, httpServer.URL, room)
	if first.Type != "welcome" || len(first.Members) != 0 {
		t.Fatalf("unexpected welcome: %+v", first)
	}
	b, second := connectTest(t, httpServer.URL, room)
	if len(second.Members) != 1 || second.Members[0] != first.ID {
		t.Fatalf("unexpected peers: %+v", second)
	}
	_, other := connectTest(t, httpServer.URL, strings.Repeat("b", 32))
	sendTest(t, a, message{Type: "state", To: second.ID, Payload: "encrypted payload"})
	received := readType(t, b, "state")
	if received.From != first.ID || received.Payload != "encrypted payload" {
		t.Fatalf("bad relay: %+v", received)
	}
	sendTest(t, a, message{Type: "state", To: other.ID, Payload: "cross-room"})
	if readType(t, a, "error").Error == "" {
		t.Fatal("expected isolation error")
	}
	sendTest(t, a, message{Type: "snapshot", Payload: "not permitted"})
	if readType(t, a, "error").Error == "" {
		t.Fatal("expected validation error")
	}
	_ = b.CloseNow()
	left := readType(t, a, "member-left")
	if left.ID != second.ID {
		t.Fatal("wrong departing peer")
	}
	_ = a.CloseNow()
	deadline := time.Now().Add(3 * time.Second)
	for {
		s.mu.Lock()
		_, exists := s.rooms[room]
		s.mu.Unlock()
		if !exists {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("empty room was retained")
		}
		time.Sleep(time.Millisecond * 10)
	}
}
func TestCapacityAndInvalidRooms(t *testing.T) {
	s := newServer()
	h := httptest.NewServer(s.handler(t.TempDir()))
	defer h.Close()
	_, invalid := connectTest(t, h.URL, "bad")
	if invalid.Type != "error" {
		t.Fatal("invalid room accepted")
	}
	for i := 0; i < maxParticipants; i++ {
		_, m := connectTest(t, h.URL, strings.Repeat("c", 32))
		if m.Type != "welcome" {
			t.Fatalf("peer %d rejected", i)
		}
	}
	_, full := connectTest(t, h.URL, strings.Repeat("c", 32))
	if full.Type != "error" || !strings.Contains(full.Error, "20") {
		t.Fatal("capacity was not enforced")
	}
}
func TestHealth(t *testing.T) {
	health := httptest.NewRecorder()
	newServer().handler(t.TempDir()).ServeHTTP(health, httptest.NewRequest("GET", "/healthz", nil))
	if health.Code != 200 || health.Body.String() != `{"status":"ok"}` {
		t.Fatal("health endpoint failed")
	}
}
func TestBroadcastIsLimitedToRoom(t *testing.T) {
	s := newServer()
	h := httptest.NewServer(s.handler(t.TempDir()))
	defer h.Close()
	room := strings.Repeat("a", 32)
	a, first := connectTest(t, h.URL, room)
	b, _ := connectTest(t, h.URL, room)
	c, _ := connectTest(t, h.URL, room)
	other, outsider := connectTest(t, h.URL, strings.Repeat("b", 32))
	sendTest(t, a, message{Type: "state", Payload: "broadcast"})
	for _, target := range []*websocket.Conn{b, c} {
		received := readType(t, target, "state")
		if received.From != first.ID || received.Payload != "broadcast" || received.To != "" {
			t.Fatalf("invalid broadcast: %+v", received)
		}
	}
	// The outsider can receive an explicit same-room frame but cannot receive another room's broadcast.
	neighbor, _ := connectTest(t, h.URL, strings.Repeat("b", 32))
	sendTest(t, neighbor, message{Type: "state", To: outsider.ID, Payload: "own room"})
	received := readType(t, other, "state")
	if received.Payload != "own room" {
		t.Fatal("broadcast escaped its room")
	}
}
