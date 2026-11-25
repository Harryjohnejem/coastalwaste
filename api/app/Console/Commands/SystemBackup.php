<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\File;
use Symfony\Component\Process\Process;

/**
 * Backups in storage/app/backups:
 *   db-YYYYmmdd-HHMMSS.sql.gz      the MySQL database (every run)
 *   files-YYYYmmdd-HHMMSS.tar.gz   snapshots and review images (with --files)
 * Old backups are removed: the newest 14 database and 4 file backups stay.
 *
 * Scheduled in routes/console.php (database daily, files weekly); it runs while
 * "php artisan schedule:work" is running (start-system.ps1 starts it).
 */
class SystemBackup extends Command
{
    protected $signature = 'system:backup {--files : Also pack storage/app/public (snapshots, review images)}';

    protected $description = 'Back up the database (and optionally the saved images) to storage/app/backups';

    private const KEEP_DB = 14;

    private const KEEP_FILES = 4;

    public function handle(): int
    {
        $dir = storage_path('app/backups');
        File::ensureDirectoryExists($dir);
        $stamp = now()->format('Ymd-His');

        $ok = $this->backupDatabase($dir.DIRECTORY_SEPARATOR."db-{$stamp}.sql.gz");
        if ($this->option('files')) {
            $ok = $this->backupFiles($dir.DIRECTORY_SEPARATOR."files-{$stamp}.tar.gz") && $ok;
        }
        $this->prune($dir, 'db-*.sql.gz', self::KEEP_DB);
        $this->prune($dir, 'files-*.tar.gz', self::KEEP_FILES);

        return $ok ? self::SUCCESS : self::FAILURE;
    }

    private function backupDatabase(string $target): bool
    {
        $connection = config('database.connections.'.config('database.default'));
        if (($connection['driver'] ?? '') !== 'mysql' && ($connection['driver'] ?? '') !== 'mariadb') {
            $this->warn('Database backup skipped: only MySQL/MariaDB is supported.');

            return true;
        }
        $dump = $this->mysqldump();
        if ($dump === null) {
            $this->error('mysqldump was not found. Set BACKUP_MYSQLDUMP in api/.env to its full path.');

            return false;
        }

        $process = new Process([
            $dump,
            '--host='.($connection['host'] ?? '127.0.0.1'),
            '--port='.($connection['port'] ?? 3306),
            '--user='.($connection['username'] ?? 'root'),
            '--single-transaction',
            '--routines',
            '--default-character-set=utf8mb4',
            (string) ($connection['database'] ?? ''),
        ], null, ['MYSQL_PWD' => (string) ($connection['password'] ?? '')], null, 600);
        $process->run();
        if (! $process->isSuccessful() || trim($process->getOutput()) === '') {
            $this->error('Database backup failed: '.trim($process->getErrorOutput()));

            return false;
        }

        File::put($target, gzencode($process->getOutput(), 6));
        $this->info('Database backup: '.basename($target).' ('.$this->size($target).')');

        return true;
    }

    private function backupFiles(string $target): bool
    {
        $source = storage_path('app/public');
        if (! is_dir($source)) {
            return true;
        }
        // tar is built into Windows 10/11 and every Linux. On Windows use the
        // system one: Git's GNU tar reads "C:" as a remote host.
        $tar = 'tar';
        if (PHP_OS_FAMILY === 'Windows') {
            $system = (getenv('SystemRoot') ?: 'C:\Windows').'\System32\tar.exe';
            if (is_file($system)) {
                $tar = $system;
            }
        }
        $process = new Process([$tar, '-czf', $target, '-C', $source, '.'], null, null, null, 1800);
        $process->run();
        if (! $process->isSuccessful()) {
            $this->error('Files backup failed: '.trim($process->getErrorOutput()));

            return false;
        }
        $this->info('Files backup: '.basename($target).' ('.$this->size($target).')');

        return true;
    }

    private function mysqldump(): ?string
    {
        $candidates = array_filter([
            env('BACKUP_MYSQLDUMP'),
            'C:\\Users\\Admin\\Downloads\\UniServerZ\\core\\mysql\\bin\\mysqldump.exe',
            'C:\\xampp\\mysql\\bin\\mysqldump.exe',
            '/usr/bin/mysqldump',
        ]);
        foreach ($candidates as $path) {
            if (is_file($path)) {
                return $path;
            }
        }
        $which = new Process(PHP_OS_FAMILY === 'Windows' ? ['where', 'mysqldump'] : ['which', 'mysqldump']);
        $which->run();
        $found = trim(strtok($which->getOutput(), "\r\n") ?: '');

        return $found !== '' && is_file($found) ? $found : null;
    }

    private function prune(string $dir, string $pattern, int $keep): void
    {
        $files = glob($dir.DIRECTORY_SEPARATOR.$pattern) ?: [];
        rsort($files);
        foreach (array_slice($files, $keep) as $old) {
            @unlink($old);
        }
    }

    private function size(string $file): string
    {
        $bytes = (int) @filesize($file);

        return $bytes >= 1048576 ? round($bytes / 1048576, 1).' MB' : round($bytes / 1024).' KB';
    }
}
