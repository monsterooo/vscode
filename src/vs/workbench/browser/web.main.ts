/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mark } from 'vs/base/common/performance';
import { domContentLoaded, addDisposableListener, EventType, addClass, EventHelper } from 'vs/base/browser/dom';
import { ServiceCollection } from 'vs/platform/instantiation/common/serviceCollection';
import { ILogService, ConsoleLogService, MultiplexLogService } from 'vs/platform/log/common/log';
import { Disposable } from 'vs/base/common/lifecycle';
import { BrowserWorkbenchEnvironmentService } from 'vs/workbench/services/environment/browser/environmentService';
import { Workbench } from 'vs/workbench/browser/workbench';
import { RemoteFileSystemProvider } from 'vs/workbench/services/remote/common/remoteAgentFileSystemChannel';
import { IWorkbenchEnvironmentService } from 'vs/workbench/services/environment/common/environmentService';
import { IProductService } from 'vs/platform/product/common/productService';
import product from 'vs/platform/product/common/product';
import { RemoteAgentService } from 'vs/workbench/services/remote/browser/remoteAgentServiceImpl';
import { RemoteAuthorityResolverService } from 'vs/platform/remote/browser/remoteAuthorityResolverService';
import { IRemoteAuthorityResolverService } from 'vs/platform/remote/common/remoteAuthorityResolver';
import { IRemoteAgentService } from 'vs/workbench/services/remote/common/remoteAgentService';
import { IFileService } from 'vs/platform/files/common/files';
import { FileService } from 'vs/platform/files/common/fileService';
import { Schemas } from 'vs/base/common/network';
import { IWorkspaceContextService } from 'vs/platform/workspace/common/workspace';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { onUnexpectedError } from 'vs/base/common/errors';
import * as browser from 'vs/base/browser/browser';
import * as platform from 'vs/base/common/platform';
import { URI } from 'vs/base/common/uri';
import { IWorkspaceInitializationPayload } from 'vs/platform/workspaces/common/workspaces';
import { WorkspaceService } from 'vs/workbench/services/configuration/browser/configurationService';
import { ConfigurationCache } from 'vs/workbench/services/configuration/browser/configurationCache';
import { ISignService } from 'vs/platform/sign/common/sign';
import { SignService } from 'vs/platform/sign/browser/signService';
import { hash } from 'vs/base/common/hash';
import { IWorkbenchConstructionOptions, IWorkspace } from 'vs/workbench/workbench.web.api';
import { FileUserDataProvider } from 'vs/workbench/services/userData/common/fileUserDataProvider';
import { BACKUPS } from 'vs/platform/environment/common/environment';
import { joinPath } from 'vs/base/common/resources';
import { BrowserStorageService } from 'vs/platform/storage/browser/storageService';
import { IStorageService } from 'vs/platform/storage/common/storage';
import { getThemeTypeSelector, DARK, HIGH_CONTRAST, LIGHT } from 'vs/platform/theme/common/themeService';
import { InMemoryFileSystemProvider } from 'vs/workbench/services/userData/common/inMemoryUserDataProvider';
import { registerWindowDriver } from 'vs/platform/driver/browser/driver';
import { BufferLogService } from 'vs/platform/log/common/bufferLog';
import { FileLogService } from 'vs/platform/log/common/fileLogService';
import { toLocalISOString } from 'vs/base/common/date';
import { IndexedDBLogProvider } from 'vs/workbench/services/log/browser/indexedDBLogProvider';
import { InMemoryLogProvider } from 'vs/workbench/services/log/common/inMemoryLogProvider';
import { isWorkspaceToOpen, isFolderToOpen } from 'vs/platform/windows/common/windows';
import { getWorkspaceIdentifier } from 'vs/workbench/services/workspaces/browser/workspaces';

/**
 * 创建浏览器工作台类
 */
class BrowserMain extends Disposable {

	constructor(
		private readonly domElement: HTMLElement,
		private readonly configuration: IWorkbenchConstructionOptions
	) {
		super();
	}

	// MYREAD 创建工作台入口3
	async open(): Promise<void> {
		// 初始化服务
		const services = await this.initServices();
		// 等待dom内容加载完毕
		await domContentLoaded();
		mark('willStartWorkbench');

		// Base Theme
		// 从localStorage中恢复theme
		this.restoreBaseTheme();

		// Create Workbench
		// 创建工作台
		const workbench = new Workbench(
			this.domElement,
			services.serviceCollection,
			services.logService
		);

		// Listeners
		// 注册事件
		this.registerListeners(workbench, services.storageService);

		// Driver
		if (this.configuration.driver) {
			(async () => this._register(await registerWindowDriver()))();
		}

		// Startup
		// 工作台启动
		workbench.startup();
	}

	private registerListeners(workbench: Workbench, storageService: BrowserStorageService): void {

		// Layout
		const viewport = platform.isIOS && (<any>window).visualViewport ? (<any>window).visualViewport /** Visual viewport */ : window /** Layout viewport */;
		this._register(addDisposableListener(viewport, EventType.RESIZE, () => {
			workbench.layout();
		}));

		// Prevent the back/forward gestures in macOS
		this._register(addDisposableListener(this.domElement, EventType.WHEEL, (e) => {
			e.preventDefault();
		}, { passive: false }));

		// Prevent native context menus in web
		this._register(addDisposableListener(this.domElement, EventType.CONTEXT_MENU, (e) => EventHelper.stop(e, true)));

		// Prevent default navigation on drop
		this._register(addDisposableListener(this.domElement, EventType.DROP, (e) => EventHelper.stop(e, true)));

		// Workbench Lifecycle
		this._register(workbench.onBeforeShutdown(event => {
			if (storageService.hasPendingUpdate) {
				console.warn('Unload prevented: pending storage update');
				event.veto(true); // prevent data loss from pending storage update
			}
		}));
		this._register(workbench.onWillShutdown(() => {
			storageService.close();
			this.saveBaseTheme();
		}));
		this._register(workbench.onShutdown(() => this.dispose()));

		// Fullscreen
		[EventType.FULLSCREEN_CHANGE, EventType.WK_FULLSCREEN_CHANGE].forEach(event => {
			this._register(addDisposableListener(document, event, () => {
				if (document.fullscreenElement || (<any>document).webkitFullscreenElement || (<any>document).webkitIsFullScreen) {
					browser.setFullscreen(true);
				} else {
					browser.setFullscreen(false);
				}
			}));
		});
	}

	private restoreBaseTheme(): void {
		addClass(this.domElement, window.localStorage.getItem('vscode.baseTheme') || getThemeTypeSelector(DARK));
	}

	private saveBaseTheme(): void {
		const classes = this.domElement.className;
		const baseThemes = [DARK, LIGHT, HIGH_CONTRAST].map(baseTheme => getThemeTypeSelector(baseTheme));
		for (const baseTheme of baseThemes) {
			if (classes.indexOf(baseTheme) >= 0) {
				window.localStorage.setItem('vscode.baseTheme', baseTheme);
				break;
			}
		}
	}

	/**
	 * 服务是一系列公共模块，它们都是依赖注入模式
	 */
	private async initServices(): Promise<{ serviceCollection: ServiceCollection, logService: ILogService, storageService: BrowserStorageService }> {
		// 服务收集
		const serviceCollection = new ServiceCollection();

		// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
		// NOTE: DO NOT ADD ANY OTHER SERVICE INTO THE COLLECTION HERE.
		// CONTRIBUTE IT VIA WORKBENCH.WEB.MAIN.TS AND registerSingleton().
		// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

		// Log
		const logsPath = URI.file(toLocalISOString(new Date()).replace(/-|:|\.\d+Z$/g, '')).with({ scheme: 'vscode-log' });
		// 日志服务
		const logService = new BufferLogService(this.configuration.logLevel);
		serviceCollection.set(ILogService, logService);

		// 解析工作台初始化数据
		const payload = this.resolveWorkspaceInitializationPayload();

		// Environment
		// 浏览器环境服务
		const environmentService = new BrowserWorkbenchEnvironmentService({ workspaceId: payload.id, logsPath, ...this.configuration });
		serviceCollection.set(IWorkbenchEnvironmentService, environmentService);

		// Product
		const productService = {
			_serviceBrand: undefined,
			...product
		};
		serviceCollection.set(IProductService, productService);

		// Remote
		// 远程授权服务
		const remoteAuthorityResolverService = new RemoteAuthorityResolverService(this.configuration.resourceUriProvider);
		serviceCollection.set(IRemoteAuthorityResolverService, remoteAuthorityResolverService);

		// Signing
		const signService = new SignService(environmentService.configuration.connectionToken);
		serviceCollection.set(ISignService, signService);

		// Remote Agent
		// 远程代理服务
		const remoteAgentService = this._register(new RemoteAgentService(this.configuration.webSocketFactory, environmentService, productService, remoteAuthorityResolverService, signService, logService));
		serviceCollection.set(IRemoteAgentService, remoteAgentService);

		// Files
		// 文件服务
		const fileService = this._register(new FileService(logService));
		serviceCollection.set(IFileService, fileService);
		this.registerFileSystemProviders(environmentService, fileService, remoteAgentService, logService, logsPath);

		// Long running services (workspace, config, storage)
		const services = await Promise.all([
			this.createWorkspaceService(payload, environmentService, fileService, remoteAgentService, logService).then(service => {

				// Workspace
				serviceCollection.set(IWorkspaceContextService, service);

				// Configuration
				serviceCollection.set(IConfigurationService, service);

				return service;
			}),

			this.createStorageService(payload, environmentService, fileService, logService).then(service => {

				// Storage
				serviceCollection.set(IStorageService, service);

				return service;
			})
		]);

		return { serviceCollection, logService, storageService: services[1] };
	}

	private registerFileSystemProviders(environmentService: IWorkbenchEnvironmentService, fileService: IFileService, remoteAgentService: IRemoteAgentService, logService: BufferLogService, logsPath: URI): void {

		// Logger
		(async () => {
			if (browser.isEdge) {
				fileService.registerProvider(logsPath.scheme, new InMemoryLogProvider(logsPath.scheme));
			} else {
				try {
					const indexedDBLogProvider = new IndexedDBLogProvider(logsPath.scheme);
					await indexedDBLogProvider.database;

					fileService.registerProvider(logsPath.scheme, indexedDBLogProvider);
				} catch (error) {
					logService.info('Error while creating indexedDB log provider. Falling back to in-memory log provider.');
					logService.error(error);

					fileService.registerProvider(logsPath.scheme, new InMemoryLogProvider(logsPath.scheme));
				}
			}

			const consoleLogService = new ConsoleLogService(logService.getLevel());
			const fileLogService = new FileLogService('window', environmentService.logFile, logService.getLevel(), fileService);
			logService.logger = new MultiplexLogService([consoleLogService, fileLogService]);
		})();

		const connection = remoteAgentService.getConnection();
		if (connection) {

			// Remote file system
			const remoteFileSystemProvider = this._register(new RemoteFileSystemProvider(remoteAgentService));
			fileService.registerProvider(Schemas.vscodeRemote, remoteFileSystemProvider);

			if (!this.configuration.userDataProvider) {
				const remoteUserDataUri = this.getRemoteUserDataUri();
				if (remoteUserDataUri) {
					this.configuration.userDataProvider = this._register(new FileUserDataProvider(remoteUserDataUri, joinPath(remoteUserDataUri, BACKUPS), remoteFileSystemProvider, environmentService));
				}
			}
		}

		// User data
		if (!this.configuration.userDataProvider) {
			this.configuration.userDataProvider = this._register(new InMemoryFileSystemProvider());
		}
		fileService.registerProvider(Schemas.userData, this.configuration.userDataProvider);
	}

	private async createStorageService(payload: IWorkspaceInitializationPayload, environmentService: IWorkbenchEnvironmentService, fileService: IFileService, logService: ILogService): Promise<BrowserStorageService> {
		const storageService = new BrowserStorageService(environmentService, fileService);

		try {
			await storageService.initialize(payload);

			return storageService;
		} catch (error) {
			onUnexpectedError(error);
			logService.error(error);

			return storageService;
		}
	}

	private async createWorkspaceService(payload: IWorkspaceInitializationPayload, environmentService: IWorkbenchEnvironmentService, fileService: FileService, remoteAgentService: IRemoteAgentService, logService: ILogService): Promise<WorkspaceService> {
		const workspaceService = new WorkspaceService({ remoteAuthority: this.configuration.remoteAuthority, configurationCache: new ConfigurationCache() }, environmentService, fileService, remoteAgentService);

		try {
			await workspaceService.initialize(payload);

			return workspaceService;
		} catch (error) {
			onUnexpectedError(error);
			logService.error(error);

			return workspaceService;
		}
	}

	private resolveWorkspaceInitializationPayload(): IWorkspaceInitializationPayload {
		let workspace: IWorkspace | undefined = undefined;
		if (this.configuration.workspaceProvider) {
			workspace = this.configuration.workspaceProvider.workspace;
		}

		// Multi-root workspace
		if (workspace && isWorkspaceToOpen(workspace)) {
			return getWorkspaceIdentifier(workspace.workspaceUri);
		}

		// Single-folder workspace
		if (workspace && isFolderToOpen(workspace)) {
			return { id: hash(workspace.folderUri.toString()).toString(16), folder: workspace.folderUri };
		}

		return { id: 'empty-window' };
	}

	private getRemoteUserDataUri(): URI | undefined {
		const element = document.getElementById('vscode-remote-user-data-uri');
		if (element) {
			const remoteUserDataPath = element.getAttribute('data-settings');
			if (remoteUserDataPath) {
				return joinPath(URI.revive(JSON.parse(remoteUserDataPath)), 'User');
			}
		}

		return undefined;
	}
}
// MYREAD 创建工作台入口3
export function main(domElement: HTMLElement, options: IWorkbenchConstructionOptions): Promise<void> {
	const renderer = new BrowserMain(domElement, options);

	return renderer.open();
}
