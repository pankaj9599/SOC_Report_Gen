import express from 'express';
import type { Request, Response, NextFunction } from 'express';

import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';
import { PDFGenerator } from '../pdf/generator';
import type { SecurityFinding, ReportData } from '../pdf/generator';

const router = express.Router();
const prisma = new PrismaClient();
const pdfGenerator = new PDFGenerator();


const reportsDir = path.join(process.cwd(), 'reports');

if (!fs.existsSync(reportsDir)) {
  fs.mkdirSync(reportsDir, { recursive: true });
}

// ══════════════════════════════════════════════════════════════════════════
// HEALTH CHECK
// ══════════════════════════════════════════════════════════════════════════

router.get('/health', async (req: Request, res: Response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({
      status: 'healthy',
      service: 'Reports API',
      database: 'connected',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      service: 'Reports API',
      database: 'disconnected',
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString(),
    });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// GENERATE REPORT
// ══════════════════════════════════════════════════════════════════════════

router.post('/generate', async (req: Request, res: Response) => {
  let reportRecord: any = null;

  try {
    const executionId = req.body.execution_id || req.body.executionId;
    const inputFindings = req.body.findings || req.body.inputFindings || [];

    if (!executionId) {
      return res.status(400).json({
        success: false,
        error: 'executionId is required',
      });
    }

    if (!Array.isArray(inputFindings)) {
      return res.status(400).json({
        success: false,
        error: 'findings must be an array',
      });
    }

    if (inputFindings.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'findings array cannot be empty',
      });
    }

    console.log(`📊 Processing ${inputFindings.length} findings for: ${executionId}`);

    // SMART DUPLICATE HANDLING
    const existingReport = await prisma.report.findUnique({
      where: { executionId },
    });

    if (existingReport) {
      const now = new Date();
      const reportAge = now.getTime() - existingReport.createdAt.getTime();
      const ageInMinutes = reportAge / (1000 * 60);

      // If report is COMPLETED and less than 1 hour old, return it
      if (existingReport.status === 'COMPLETED' && existingReport.pdfUrl && ageInMinutes < 60) {
        return res.json({
          success: true,
          message: 'Report exists and is fresh',
          data: {
            reportId: existingReport.id,
            executionId: existingReport.executionId,
            pdfUrl: existingReport.pdfUrl,
            fileSize: existingReport.fileSize,
            status: existingReport.status,
            createdAt: existingReport.createdAt,
            age: `${Math.round(ageInMinutes)} minutes`,
          },
        });
      }

      // If report is FAILED or too old, regenerate
      console.log(`🔄 Report exists but status: ${existingReport.status}, age: ${Math.round(ageInMinutes)} minutes. Regenerating...`);

      // Clean up old files
      if (existingReport.pdfPath && fs.existsSync(existingReport.pdfPath)) {
        fs.unlinkSync(existingReport.pdfPath);
      }

      // Delete old record
      await prisma.report.delete({
        where: { executionId },
      });

      console.log(`🗑️ Cleaned up old report: ${existingReport.id}`);
    }


    const findingsForPDF: SecurityFinding[] = inputFindings.map((finding: any, index: number) => ({
      id: finding.finding_id || finding.id || `finding-${index + 1}`,
      title: finding.title || finding.classification || 'Untitled Finding',
      severity: (finding.severity || 'MEDIUM').toUpperCase() as 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL',
      description: finding.description || finding.summary || 'No description provided.',
      recommendation: finding.recommendation || finding.recommended_action || 'Review and investigate this finding.',
      timestamp: finding.timestamp || new Date().toISOString(),
      source: finding.source || finding.domain || 'Unknown Source',
    }));

    const analysis = pdfGenerator.analyzeFindings(findingsForPDF);

    reportRecord = await prisma.report.create({
      data: {
        executionId,
        title: `Security Report - ${executionId}`,
        inputFindings: inputFindings as any,
        summary: {
          total: analysis.totalFindings,
          critical: analysis.criticalCount,
          high: analysis.highCount,
          medium: analysis.mediumCount,
          low: analysis.lowCount,
        } as any,
        status: 'PROCESSING',
        generatedAt: new Date(),
      },
    });

    console.log(`📝 Created report record: ${reportRecord.id}`);

    const reportData: ReportData = {
      executionId,
      findings: findingsForPDF,
      metadata: {
        generatedAt: new Date(),
        totalFindings: analysis.totalFindings,
        criticalCount: analysis.criticalCount,
        highCount: analysis.highCount,
        mediumCount: analysis.mediumCount,
        lowCount: analysis.lowCount,
      },
    };

    console.log('📄 Generating PDF...');
    const pdfBuffer = await pdfGenerator.generateReport(reportData);

    const fileName = `report-${executionId}-${Date.now()}.pdf`;
    const filePath = path.join(reportsDir, fileName);
    fs.writeFileSync(filePath, pdfBuffer);
    console.log(`✅ PDF saved: ${fileName}`);

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const downloadUrl = `${baseUrl}/api/reports/download/${fileName}`;
    const fileSize = `${(pdfBuffer.length / 1024).toFixed(2)} KB`;

    const updatedReport = await prisma.report.update({
      where: { id: reportRecord.id },
      data: {
        pdfUrl: downloadUrl,
        pdfPath: filePath,
        fileSize,
        status: 'COMPLETED',
        updatedAt: new Date(),
      },
    });

    console.log(`✅ Report completed: ${reportRecord.id}`);

    res.json({
      success: true,
      message: 'Report generated successfully',
      data: {
        reportId: updatedReport.id,
        executionId: updatedReport.executionId,
        summary: updatedReport.summary,
        pdf: {
          fileName,
          fileSize,
          downloadUrl,
          viewUrl: `${baseUrl}/api/reports/view/${fileName}`,
          localPath: filePath,
        },
        status: updatedReport.status,
        createdAt: updatedReport.createdAt,
        updatedAt: updatedReport.updatedAt,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error: any) {
    console.error('❌ Error generating report:', error);

    if (reportRecord) {
      try {
        await prisma.report.update({
          where: { id: reportRecord.id },
          data: {
            status: 'FAILED',
            summary: {
              error: error.message,
              timestamp: new Date().toISOString(),
            } as any,
            updatedAt: new Date(),
          },
        });
      } catch (dbError) {
        console.error('❌ Failed to update report status:', dbError);
      }
    }

    res.status(500).json({
      success: false,
      error: 'Failed to generate report',
      message: error.message,
      reportId: reportRecord?.id,
      timestamp: new Date().toISOString(),
    });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// GET REPORT BY ID
// ══════════════════════════════════════════════════════════════════════════

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;

    const report = await prisma.report.findUnique({
      where: { id },
    });

    if (!report) {
      return res.status(404).json({
        success: false,
        error: 'Report not found',
      });
    }

    res.json({
      success: true,
      data: report,
    });
  } catch (error) {
    console.error('❌ Error fetching report:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch report',
    });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// GET REPORT BY EXECUTION ID
// ══════════════════════════════════════════════════════════════════════════

router.get('/execution/:executionId', async (req: Request, res: Response) => {
  try {
    const executionId = req.params.executionId as string;

    const report = await prisma.report.findUnique({
      where: { executionId },
    });

    if (!report) {
      return res.status(404).json({
        success: false,
        error: 'Report not found',
      });
    }

    res.json({
      success: true,
      data: report,
    });
  } catch (error) {
    console.error('❌ Error fetching report:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch report',
    });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// LIST ALL REPORTS
// ══════════════════════════════════════════════════════════════════════════

router.get('/', async (req: Request, res: Response) => {
  try {
    const {
      page = '1',
      limit = '20',
      status,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = req.query;

    const pageNum = parseInt(page as string, 10);
    const limitNum = parseInt(limit as string, 10);
    const skip = (pageNum - 1) * limitNum;

    const where: any = {};
    if (status) {
      where.status = status;
    }

    const [reports, total] = await Promise.all([
      prisma.report.findMany({
        where,
        orderBy: { [sortBy as string]: sortOrder },
        skip,
        take: limitNum,
        select: {
          id: true,
          executionId: true,
          title: true,
          status: true,
          pdfUrl: true,
          fileSize: true,
          summary: true,
          createdAt: true,
          updatedAt: true,
          generatedAt: true,
        },
      }),
      prisma.report.count({ where }),
    ]);

    res.json({
      success: true,
      data: reports,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    console.error('❌ Error listing reports:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to list reports',
    });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// DOWNLOAD PDF
// ══════════════════════════════════════════════════════════════════════════

router.get('/download/:filename', (req: Request, res: Response) => {
  try {
    const filename = req.params.filename as string;
    const filePath = path.join(reportsDir, filename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        success: false,
        error: 'Report file not found',
      });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);
  } catch (error) {
    console.error('❌ Error downloading report:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to download report',
    });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// VIEW PDF IN BROWSER
// ══════════════════════════════════════════════════════════════════════════

router.get('/view/:filename', (req: Request, res: Response) => {
  try {
    const filename = req.params.filename as string;
    const filePath = path.join(reportsDir, filename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        success: false,
        error: 'Report file not found',
      });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);

    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);
  } catch (error) {
    console.error('❌ Error viewing report:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to view report',
    });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// DELETE REPORT
// ══════════════════════════════════════════════════════════════════════════

router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;

    const report = await prisma.report.findUnique({
      where: { id },
    });

    if (!report) {
      return res.status(404).json({
        success: false,
        error: 'Report not found',
      });
    }

    if (report.pdfPath && fs.existsSync(report.pdfPath)) {
      fs.unlinkSync(report.pdfPath);
    }

    await prisma.report.delete({
      where: { id },
    });

    res.json({
      success: true,
      message: `Report ${id} deleted successfully`,
      deletedFile: report.pdfPath,
    });
  } catch (error) {
    console.error('❌ Error deleting report:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete report',
    });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// DATABASE TEST
// ══════════════════════════════════════════════════════════════════════════

router.get('/test/db', async (req: Request, res: Response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;

    const testReport = await prisma.report.create({
      data: {
        executionId: `test-${Date.now()}`,
        title: 'Database Test Report',
        inputFindings: [{ test: 'data' }] as any,
        summary: { test: 'success' } as any,
        status: 'COMPLETED',
        generatedAt: new Date(),
      },
    });

    const count = await prisma.report.count();

    await prisma.report.delete({
      where: { id: testReport.id },
    });

    res.json({
      success: true,
      message: 'Database test successful',
      operations: {
        connection: 'OK',
        create: 'OK',
        count: 'OK',
        delete: 'OK',
      },
      count: count - 1,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: 'Database test failed',
      message: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

export default router;
