package main

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/keepalive"
	"google.golang.org/grpc/reflection"

	"github.com/liveagent/agent-gateway/internal/auth"
	"github.com/liveagent/agent-gateway/internal/config"
	"github.com/liveagent/agent-gateway/internal/observability"
	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
	"github.com/liveagent/agent-gateway/internal/server"
	"github.com/liveagent/agent-gateway/internal/session"
)

const grpcShutdownTimeout = 3 * time.Second

// fatal 记录错误并以非零码退出（slog 没有 Fatal 级别，集中在此处理）。
func fatal(msg string, args ...any) {
	slog.Error(msg, args...)
	os.Exit(1)
}

func main() {
	observability.SetupLogging()
	cfg := config.Load()
	sm := session.NewManager()

	grpcServer, err := newGRPCServer(cfg, sm)
	if err != nil {
		fatal("create gRPC server failed", "err", err)
	}

	grpcListener, err := net.Listen("tcp", cfg.GRPCAddr)
	if err != nil {
		fatal("listen gRPC failed", "addr", cfg.GRPCAddr, "err", err)
	}

	httpServer := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           server.NewHTTPServer(cfg, sm),
		ReadHeaderTimeout: 10 * time.Second,
	}

	errCh := make(chan error, 2)

	go func() {
		slog.Info("gRPC listening", "addr", cfg.GRPCAddr)
		if serveErr := grpcServer.Serve(grpcListener); serveErr != nil && !errors.Is(serveErr, grpc.ErrServerStopped) {
			errCh <- serveErr
		}
	}()

	go func() {
		slog.Info("HTTP listening", "addr", cfg.HTTPAddr)
		var serveErr error
		if cfg.TLSCert != "" || cfg.TLSKey != "" {
			serveErr = httpServer.ListenAndServeTLS(cfg.TLSCert, cfg.TLSKey)
		} else {
			serveErr = httpServer.ListenAndServe()
		}
		if serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			errCh <- serveErr
		}
	}()

	signalCh := make(chan os.Signal, 1)
	signal.Notify(signalCh, syscall.SIGINT, syscall.SIGTERM)

	select {
	case sig := <-signalCh:
		slog.Info("received signal, shutting down", "signal", sig.String())
	case err := <-errCh:
		fatal("server error", "err", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	httpShutdownErrCh := make(chan error, 1)
	go func() {
		httpShutdownErrCh <- httpServer.Shutdown(ctx)
	}()

	if forced := shutdownGRPCServer(grpcServer, grpcShutdownTimeout); forced {
		slog.Warn("gRPC graceful shutdown timed out, forcing stop", "timeout", grpcShutdownTimeout)
	}

	if err := <-httpShutdownErrCh; err != nil {
		slog.Warn("http shutdown error", "err", err)
	}
}

func newGRPCServer(cfg *config.Config, sm *session.Manager) (*grpc.Server, error) {
	options := []grpc.ServerOption{
		grpc.MaxRecvMsgSize(cfg.GRPCMaxMessageBytes),
		grpc.MaxSendMsgSize(cfg.GRPCMaxMessageBytes),
		grpc.UnaryInterceptor(auth.GRPCUnaryInterceptor(cfg.Token)),
		grpc.StreamInterceptor(auth.GRPCStreamInterceptor(cfg.Token)),
		// Transport-level liveness: h2 PINGs are not subject to application
		// queue congestion, so dead links are detected even mid-stream.
		grpc.KeepaliveParams(keepalive.ServerParameters{
			Time:    30 * time.Second,
			Timeout: 10 * time.Second,
		}),
		// The desktop GUI pings every 10-60s; MinTime must stay below its
		// floor or grpc-go answers with a too_many_pings GOAWAY.
		grpc.KeepaliveEnforcementPolicy(keepalive.EnforcementPolicy{
			MinTime:             5 * time.Second,
			PermitWithoutStream: true,
		}),
	}
	if cfg.TLSCert != "" || cfg.TLSKey != "" {
		creds, err := credentials.NewServerTLSFromFile(cfg.TLSCert, cfg.TLSKey)
		if err != nil {
			return nil, err
		}
		options = append(options, grpc.Creds(creds))
	}

	grpcServer := grpc.NewServer(options...)
	gatewayv1.RegisterAgentGatewayServer(grpcServer, server.NewGRPCServer(cfg, sm))
	reflection.Register(grpcServer)
	return grpcServer, nil
}
