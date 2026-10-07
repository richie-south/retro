package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

const maxParticipants = 20
const maxPayloadBytes = 12 * 1024 * 1024

var roomPattern = regexp.MustCompile(`^[a-f0-9]{32}$`)

type message struct {
	Type    string   `json:"type"`
	Room    string   `json:"room,omitempty"`
	ID      string   `json:"id,omitempty"`
	Members []string `json:"members,omitempty"`
	To      string   `json:"to,omitempty"`
	From    string   `json:"from,omitempty"`
	Payload string   `json:"payload,omitempty"`
	Error   string   `json:"error,omitempty"`
}
type client struct {
	id     string
	conn   *websocket.Conn
	send   chan message
	cancel context.CancelFunc
}
type server struct {
	mu      sync.Mutex
	rooms   map[string]map[string]*client
	origins []string
}

func newServer() *server { return &server{rooms: make(map[string]map[string]*client)} }
func randomID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}
func (s *server) enqueue(p *client, m message) {
	select {
	case p.send <- m:
	default:
		p.cancel()
	}
}
func (s *server) join(room string, p *client) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	members := s.rooms[room]
	if len(members) >= maxParticipants {
		return false
	}
	if members == nil {
		members = make(map[string]*client)
		s.rooms[room] = members
	}
	ids := make([]string, 0, len(members))
	for id := range members {
		ids = append(ids, id)
	}
	s.enqueue(p, message{Type: "welcome", ID: p.id, Members: ids})
	for _, other := range members {
		s.enqueue(other, message{Type: "member-joined", ID: p.id})
	}
	members[p.id] = p
	return true
}
func (s *server) leave(room string, p *client) {
	s.mu.Lock()
	defer s.mu.Unlock()
	members := s.rooms[room]
	if members[p.id] != p {
		return
	}
	delete(members, p.id)
	for _, other := range members {
		s.enqueue(other, message{Type: "member-left", ID: p.id})
	}
	if len(members) == 0 {
		delete(s.rooms, room)
	}
}
func (s *server) relay(room string, sender *client, m message) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	members := s.rooms[room]
	outgoing := message{Type: "state", From: sender.id, To: m.To, Payload: m.Payload}
	if m.To != "" {
		target := members[m.To]
		if target == nil || target == sender {
			return false
		}
		s.enqueue(target, outgoing)
	} else {
		for _, target := range members {
			if target != sender {
				s.enqueue(target, outgoing)
			}
		}
	}
	return true
}
func (s *server) socket(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: s.origins})
	if err != nil {
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(1024)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	var hello message
	initial, stop := context.WithTimeout(ctx, 10*time.Second)
	err = wsjson.Read(initial, conn, &hello)
	stop()
	if err != nil {
		return
	}
	if hello.Type != "join" || !roomPattern.MatchString(hello.Room) {
		_ = wsjson.Write(ctx, conn, message{Type: "error", Error: "Invalid room."})
		_ = conn.Close(websocket.StatusPolicyViolation, "invalid room")
		return
	}
	conn.SetReadLimit(maxPayloadBytes + 1024)
	p := &client{id: randomID(), conn: conn, send: make(chan message, 64), cancel: cancel}
	if !s.join(hello.Room, p) {
		_ = wsjson.Write(ctx, conn, message{Type: "error", Error: "This retrospective already has 20 participants."})
		_ = conn.Close(websocket.StatusPolicyViolation, "room full")
		return
	}
	defer s.leave(hello.Room, p)
	writerDone := make(chan struct{})
	go func() {
		defer close(writerDone)
		defer cancel()
		ticker := time.NewTicker(25 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case m := <-p.send:
				writeCtx, done := context.WithTimeout(ctx, 10*time.Second)
				err := wsjson.Write(writeCtx, conn, m)
				done()
				if err != nil {
					return
				}
			case <-ticker.C:
				pingCtx, done := context.WithTimeout(ctx, 10*time.Second)
				err := conn.Ping(pingCtx)
				done()
				if err != nil {
					return
				}
			}
		}
	}()
	for {
		var m message
		if err := wsjson.Read(ctx, conn, &m); err != nil {
			break
		}
		if m.Type != "state" || m.Payload == "" || len(m.Payload) > maxPayloadBytes {
			s.enqueue(p, message{Type: "error", Error: "Invalid synchronization message."})
			continue
		}
		if !s.relay(hello.Room, p, m) {
			s.enqueue(p, message{Type: "error", Error: "Participant is no longer available."})
		}
	}
	cancel()
	<-writerDone
}

func (s *server) handler(staticDir string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	mux.HandleFunc("GET /api/socket", s.socket)
	mux.HandleFunc("GET /api/", func(w http.ResponseWriter, r *http.Request) { http.NotFound(w, r) })
	files := http.FileServer(http.Dir(staticDir))
	mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "..") {
			http.NotFound(w, r)
			return
		}
		files.ServeHTTP(w, r)
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		mux.ServeHTTP(w, r)
	})
}
func listEnv(name string) []string {
	values := []string{}
	for _, v := range strings.Split(os.Getenv(name), ",") {
		if v = strings.TrimSpace(v); v != "" {
			values = append(values, v)
		}
	}
	return values
}
func main() {
	s := newServer()
	s.origins = listEnv("ALLOWED_ORIGINS")
	addr := os.Getenv("ADDR")
	if addr == "" {
		addr = ":8080"
	}
	staticDir := os.Getenv("STATIC_DIR")
	if staticDir == "" {
		staticDir = filepath.Join("..", "ui", "build")
	}
	srv := &http.Server{Addr: addr, Handler: s.handler(staticDir), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		timeout, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(timeout)
		s.mu.Lock()
		defer s.mu.Unlock()
		for _, room := range s.rooms {
			for _, p := range room {
				p.cancel()
			}
		}
	}()
	log.Printf("retro listening on %s", addr)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
