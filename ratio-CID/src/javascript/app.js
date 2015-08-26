Ext.define("TSCIDRatio", {
    extend: 'Rally.app.TimeboxScopedApp',
    scopeType: 'release',
    supportsUnscheduled: false,
    
    componentCls: 'app',
    logger: new Rally.technicalservices.Logger(),
    defaults: { margin: 10 },
    config: {
        defaultSettings: {
            showByVersion:  false
        }
    },
    
    onScopeChange: function(newTimeboxScope) {
        this.callParent(arguments);
        var timebox = this.getContext().getTimeboxScope().getRecord();
        
        this.startDate = timebox.get('ReleaseStartDate');
        this.endDate = timebox.get('ReleaseDate');
        
        this._launch();
    },

    _launch: function() {
        var me = this;
        
        Deft.Chain.pipeline([
            this._getDefectsInTimebox,
            this._aggregateDefects,
            this._calculateValues
        ],this).then({
            scope: this,
            success: function(rows) { 
                this._displayGrid(rows);
            },
            failure: function(msg) { Ext.Msg.alert('Problem', msg); }
        });
    },
    
    _getDefectsInTimebox: function() {
        var deferred = Ext.create('Deft.Deferred');
        var me = this;
        
        me.setLoading("Loading Defects...");
        
        var severity_filters = Rally.data.wsapi.Filter.or([
            { property: 'Severity', value: 'Minor Problem' },
            { property: 'Severity', value: 'Major Problem' },
            { property: 'Severity', value: 'Crash/Data Loss' }
        ]);
        
        var date_filters = Rally.data.wsapi.Filter.and([
            { property:'CreationDate', operator: '>=', value: this.startDate },
            { property:'CreationDate', operator: '<=', value: this.endDate }
        ]);
        
        var filters = date_filters.and(severity_filters);
        
        var store_config = {
            model:'Defect',
            filters: filters,
            fetch: ['FormattedID','CreationDate','Severity','Tags','c_IncidentCases']
        };
        
        this._loadRecordsAsApromise(store_config).then({
            success: function(records) {
                deferred.resolve(records);
            },
            failure: function(error_message){
                alert(error_message);
            }
        }).always(function() {
            me.setLoading(false);
        });
        
        return deferred.promise;
    },
    
    _aggregateDefects: function(defects) {
        if ( this.getSetting('showByVersion') ) {
            return this._aggregateDefectsByReleaseTag(defects);
        } 
        return this._aggregateDefectsByCreationMonth(defects);
    },
    
    _aggregateDefectsByCreationMonth: function(defects) {
        var me = this;
        var rows_by_month = {};
        
        Ext.Array.each(defects, function(defect) {
            var creation_date = defect.get('CreationDate');
            var month = new Date(creation_date.getFullYear(), creation_date.getMonth(), 1);

            if ( Ext.isEmpty(rows_by_month[month]) ) {
                rows_by_month[month] = { 
                    name:month, 
                    count: 0, 
                    incident_count: 0, 
                    cid_count: 0, 
                    ratio: -1,
                    defects: []
                };
            }
                    
            var count = rows_by_month[month].count;
            rows_by_month[month].count = count + 1;
            rows_by_month[month].defects.push(defect);
        }); // end of defects
        
        return Ext.Object.getValues(rows_by_month);
    },
    
    _aggregateDefectsByReleaseTag: function(defects) {
        var me = this;
        var rows_by_tag = {};
        
        Ext.Array.each(defects, function(defect) {
            var tags = defect.get('Tags')._tagsNameArray;
            Ext.Array.each(tags, function(tag){
                var tag_name = tag.Name;
                if ( /v\d\.\d\.\d*/.test(tag_name) ) {
                    tag_name = tag_name.replace(/.*(v\d)/,"$1");

                    if ( Ext.isEmpty(rows_by_tag[tag_name]) ) {
                        rows_by_tag[tag_name] = { 
                            name:tag_name, 
                            count: 0, 
                            incident_count: 0, 
                            cid_count: 0, 
                            ratio: -1,
                            defects: []
                        };
                    }
                    
                    var count = rows_by_tag[tag_name].count;
                    rows_by_tag[tag_name].count = count + 1;
                    rows_by_tag[tag_name].defects.push(defect);
                }
            });  // end of tags (for each defect)
        }); // end of defects
        
        return Ext.Object.getValues(rows_by_tag);
    },
    
    _isCID: function(defect) {
        var tags = Ext.Array.pluck( defect.get('Tags')._tagsNameArray, 'Name' );
        return Ext.Array.contains(tags,'CID');
    },
    
    _hasIncident: function(defect) {
        var cases_link = defect.get('c_IncidentCases');
        //this.logger.log(defect.get('FormattedID'), cases_link, cases_link.LinkID);
        return ( !Ext.isEmpty(cases_link.LinkID) );
    },
    
    _calculateValues: function(rows) {
        var me = this;
        Ext.Array.each(rows, function(row){
            var defects = row.defects;
            row.cid_count = Ext.Array.filter(defects, function(defect){
                return me._isCID(defect);
            }).length;
            
            row.incident_count = Ext.Array.filter(defects, function(defect){
                return me._hasIncident(defect);
            }).length;
            
            if ( row.cid_count > 0 ) {
                row.ratio = row.incident_count / row.cid_count;
            }
        });
        
        return rows;
    },

    _loadRecordsAsApromise: function(store_config){
        var deferred = Ext.create('Deft.Deferred');
        var me = this;
        
        var config = Ext.apply({
            model: 'HierarchicalRequirement',
            fetch: ['ObjectID']
        },store_config);
        
        Ext.create('Rally.data.wsapi.Store', config).load({
            callback : function(records, operation, successful) {
                if (successful){
                    deferred.resolve(records);
                } else {
                    me.logger.log("Failed: ", operation);
                    deferred.reject('Problem loading: ' + operation.error.errors.join('. '));
                }
            }
        });
        return deferred.promise;
    },
    
    _getGridColumns: function() {
        var columns = [];
        if ( this.getSetting('showByVersion') ) {
            columns.push({dataIndex:'name',text:''});
        } else {
            columns.push({dataIndex:'name',text:'',renderer: Ext.util.Format.dateRenderer('M-y') });
        }
        columns = Ext.Array.merge(columns, [
            {dataIndex:'incident_count',text:'Incident #s Tied Defects'},
            {dataIndex:'cid_count', text:'QA Filed CID defects'},
            {dataIndex:'ratio', text:'CID Ratio',renderer: function(value){
                if ( value < 0 ) {
                    return "N/A";
                }
                return Ext.util.Format.number(value,'0.00');
            }}
        ]);
        
        return columns;
    },
    
    _displayGrid: function(rows){
        var store = Ext.create('Rally.data.custom.Store',{
            data:rows,
            sorters: [{property:'name'}]
        });
        
        if ( this.grid ) { this.grid.destroy(); }
        
        this.grid = this.add({
            xtype: 'rallygrid',
            store: store,
            showPagingToolbar: false,
            columnCfgs: this._getGridColumns()
        });
    },
    
    getSettingsFields: function() {
        return [
            {
                name: 'showByVersion',
                xtype: 'rallycheckboxfield',
                boxLabelAlign: 'after',
                fieldLabel: '',
                margin: '0 0 25 200',
                boxLabel: 'Show by Version<br/><span style="color:#999999;"><i>Tick to use version number for aggregation.  Otherwise, uses creation month.</i></span>'
            }
        ];
    },
    
    getOptions: function() {
        return [
            {
                text: 'About...',
                handler: this._launchInfo,
                scope: this
            }
        ];
    },
    
    _launchInfo: function() {
        if ( this.about_dialog ) { this.about_dialog.destroy(); }
        this.about_dialog = Ext.create('Rally.technicalservices.InfoLink',{});
    },
    
    isExternal: function(){
        return typeof(this.getAppId()) == 'undefined';
    },
    
    //onSettingsUpdate:  Override
    onSettingsUpdate: function (settings){
        this.logger.log('onSettingsUpdate',settings);
        Ext.apply(this, settings);
        this.launch();
    }
});
